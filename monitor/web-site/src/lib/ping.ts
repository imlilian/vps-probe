import { useEffect, useSyncExternalStore } from "react"

// Relative with its extension rather than the `@/` alias: `npm test` runs this
// module's pure half under plain node, which resolves neither an alias nor a
// bare directory.
import { api, ApiError } from "./api.ts"

/**
 * Latency probes, as the hub answers `/api/nodes/{id}/metrics?series=ping`:
 * one row per probe per bucket, `latency` the bucket's median (null when every
 * sample in it timed out), `loss` the share of that bucket that did, absent when
 * none did. `loss` on the response is the whole window's figure per probe, and
 * it is the only one that may be printed: averaging the per-bucket percentages
 * divides by the wrong count, since the buckets do not hold the same number of
 * samples -- the last one holds only the minutes that have elapsed.
 */
export type PingRow = { task_id: number; ts: number; latency: number | null; loss?: number }

export type PingData = {
  ping: PingRow[]
  probes: Record<string, string>
  loss?: Record<string, number>
}

/** One block of a strip: the buckets that fell in it, or null for none at all. */
export type Slot = { ts: number; latency: number | null; loss: number } | null

export type ProbeStats = {
  id: number
  name: string
  /** The newest bucket's median, null when it timed out or there is none. */
  latest: number | null
  timedOut: boolean
  /** The line's usual latency: the median of the buckets that answered. */
  typical: number | null
  /** Window loss in percent, null without samples. */
  loss: number | null
  slots: Slot[]
}

/**
 * Twenty blocks of three minutes: one hour, at a resolution where a bad stretch
 * is a run of blocks rather than a single pixel. Three minutes is also short
 * enough that a congestion episode lands in two or three of them, which is what
 * makes it visible at a glance.
 */
export const SLOTS = 20
export const BLOCK = 180
export const HOURS = 1

/** The design case. More probes than this are dropped, fewer are laid out to fit. */
export const MAX_PROBES = 3

/**
 * Folds a probe's buckets into `count` blocks ending at `until`. A block's
 * latency is the mean of the buckets in it that answered, null when none did;
 * its loss the mean of their percentages.
 *
 * That mean is exact here, unlike the window figure: every bucket in a block
 * holds the same number of samples, except the last one, which is still filling.
 * It colours a block and nothing else -- no percentage is ever printed from it.
 */
export function buildSlots(rows: PingRow[], until: number, count = SLOTS, block = BLOCK): Slot[] {
  const since = until - count * block
  // `ts` is the block's opening minute rather than the last bucket in it, so a
  // tooltip names the interval the reader is pointing at.
  const sums = Array.from({ length: count }, (_, i) => ({ ts: since + i * block, n: 0, answered: 0, latency: 0, loss: 0 }))
  for (const row of rows) {
    if (row.ts < since || row.ts >= until) continue
    const s = sums[Math.min(count - 1, Math.floor((row.ts - since) / block))]
    s.n++
    // A bucket with no latency is one where every sample timed out, which is a
    // hundred percent lost and not a missing figure.
    s.loss += row.latency === null ? 100 : (row.loss ?? 0)
    if (row.latency !== null) {
      s.answered++
      s.latency += row.latency
    }
  }
  return sums.map((s) =>
    s.n ? { ts: s.ts, latency: s.answered ? s.latency / s.answered : null, loss: s.loss / s.n } : null,
  )
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** One probe of one node over the window ending at `until`. */
export function probeStats(
  data: PingData,
  probe: { id: number; name: string },
  until: number,
  count = SLOTS,
): ProbeStats {
  const rows = data.ping.filter((r) => r.task_id === probe.id).sort((a, b) => a.ts - b.ts)
  const answered = rows.flatMap((r) => (r.latency === null ? [] : [r.latency]))
  const last = rows.at(-1)
  return {
    ...probe,
    latest: last?.latency ?? null,
    timedOut: Boolean(last && last.latency === null),
    typical: median(answered),
    // Zero loss is left out of `loss` by the hub, so an absent key means none.
    loss: rows.length ? (data.loss?.[probe.id] ?? 0) : null,
    slots: buildSlots(rows, until, count),
  }
}

/**
 * The probes a card shows: by id, the first three, in the operator's numbering.
 * A card is a fixed shape twenty blocks wide, and a fourth strip would either
 * halve the width of the other three or double the height of every card on the
 * page; the node's page carries the rest.
 */
export function cardProbes(data: PingData, now = Date.now() / 1000, count = SLOTS): ProbeStats[] {
  // The strip's right edge is the hub's newest bucket, rounded up to the block
  // grid -- not the visitor's clock. Every other count on the card (`expires_in`,
  // `last_seen_ago`) is deliberately on the hub's calendar for the same reason:
  // a phone ten minutes out would put the whole window past every row, leaving
  // twenty empty blocks under a figure that still reads `36 ms`, and one card
  // would contradict itself. `now` is only the fallback for a node with no rows.
  const newest = data.ping.reduce((hi, row) => (Number.isFinite(row.ts) ? Math.max(hi, row.ts) : hi), 0)
  const until = Math.ceil((newest || now) / BLOCK) * BLOCK
  return Object.entries(data.probes ?? {})
    .map(([id, name]) => ({ id: Number(id), name }))
    .filter((p) => Number.isFinite(p.id))
    .sort((a, b) => a.id - b.id)
    .slice(0, MAX_PROBES)
    .map((p) => probeStats(data, p, until, count))
}

/**
 * Five steps, 1 the best and 5 the worst, 0 for no data at all. Loss is judged
 * by the figure itself. Latency is judged against the line's own usual: 270 ms
 * is normal to the other side of the world and a fault to the next city, so what
 * colours a figure is how far above its line's median it sits, as a share of
 * that median, with a 30 ms floor so a line that normally answers in 3 ms is not
 * alarming at 6.
 */
const LOSS_STEPS = [1, 3, 6, 9]
const LATENCY_STEPS = [0.25, 0.6, 1.2, 2]
const LATENCY_FLOOR = 30

export function lossSignal(loss: number | null): number {
  if (loss === null) return 0
  const i = LOSS_STEPS.findIndex((t) => loss <= t)
  return i < 0 ? 5 : i + 1
}

export function latencySignal(ms: number | null, typical: number | null): number {
  if (ms === null) return 0
  if (typical === null) return 1
  const excess = (ms - typical) / Math.max(typical, LATENCY_FLOOR)
  const i = LATENCY_STEPS.findIndex((t) => excess <= t)
  return i < 0 ? 5 : i + 1
}

/**
 * A block is coloured by whichever of its two readings is worse. One strip
 * rather than two: with three probes on a card, two strips each is six rows of
 * colour for one question -- is this line well -- and the loss is already the
 * faster of the two to notice.
 */
export function slotSignal(slot: Slot, typical: number | null): number {
  if (!slot) return 0
  if (slot.latency === null) return 5
  return Math.max(latencySignal(slot.latency, typical), lossSignal(slot.loss))
}

/** A figure's step: a timeout is the worst latency there is. */
export function probeLatencySignal(probe: ProbeStats): number {
  return probe.timedOut ? 5 : latencySignal(probe.latest, probe.typical)
}

/**
 * One row of blocks for the compact list: per block, the worst step any of the
 * drawn probes reached.
 *
 * A 4px band across a 48px row cannot show three lines apart -- at that height
 * two blocks of congestion are two dots -- and it does not need to: the question
 * a compact row answers is "was this machine's way out unwell in the last hour".
 * Which line, and by how much, is one press away on the node's own page. Taking
 * the worst rather than the average is the same rule the single strip already
 * follows (D15): trouble is what the colour is for, and an average would hide
 * one bad probe behind two good ones.
 */
export function mergedSignals(probes: ProbeStats[]): number[] {
  const width = probes[0]?.slots.length ?? 0
  return Array.from({ length: width }, (_, i) =>
    probes.reduce((worst, probe) => Math.max(worst, slotSignal(probe.slots[i] ?? null, probe.typical)), 0),
  )
}

export const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toString())
export const fmtLoss = (pct: number) =>
  pct === 0 ? "0" : pct < 0.1 ? "<0.1" : pct < 10 ? pct.toFixed(1) : Math.round(pct).toString()

// ---- fetching ----------------------------------------------------------------

type Entry = { data: PingData | null; error: string; at: number }

/** How long a reading is served before it is fetched again. */
const FRESH = 60_000

const cache = new Map<string, Entry>()

/**
 * One subscriber set per node, made once. `useSyncExternalStore` resubscribes
 * whenever the function it is handed changes identity, and the page re-renders
 * on every pushed frame: a fresh closure per render would detach and reattach
 * every card every two seconds.
 */
const channels = new Map<string, { set: Set<() => void>; subscribe: (fn: () => void) => () => void }>()

function channel(key: string) {
  let found = channels.get(key)
  if (!found) {
    const set = new Set<() => void>()
    found = {
      set,
      subscribe: (fn) => {
        set.add(fn)
        return () => set.delete(fn)
      },
    }
    channels.set(key, found)
  }
  return found
}

const inflight = new Set<string>()

/**
 * The hub refuses a fifth concurrent history query with 503 rather than queueing
 * it, and every card asks as soon as its node arrives, so the requests queue
 * here: two at a time. Ten cards then take five rounds of one query rather than
 * a burst the hub answers mostly with 503.
 */
const CONCURRENCY = 2
const queue: (() => Promise<void>)[] = []
let running = 0

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!
    running++
    void job().finally(() => {
      running--
      pump()
    })
  }
}

function publish(key: string, entry: Entry) {
  cache.set(key, entry)
  channel(key).set.forEach((fn) => fn())
}

async function load(id: number, hours: number, attempt: number) {
  const key = `${id}:${hours}`
  try {
    const data = await api<PingData>(`/nodes/${id}/metrics?series=ping&hours=${hours}&points=60`)
    inflight.delete(key)
    publish(key, { data, error: "", at: Date.now() })
  } catch (e) {
    // Busy: the gate was full before this request got in, which says nothing
    // about the node. Two more tries, backing off, then the page goes without.
    if (e instanceof ApiError && e.status === 503 && attempt < 2) {
      setTimeout(() => {
        queue.push(() => load(id, hours, attempt + 1))
        pump()
      }, 2000 * (attempt + 1))
      return
    }
    inflight.delete(key)
    const prev = cache.get(key)
    // `at` pushed back so the next try comes in about 15 s rather than a minute.
    publish(key, {
      data: prev?.data ?? null,
      error: e instanceof Error ? e.message : "读取失败",
      at: Date.now() - FRESH + 15_000,
    })
  }
}

export function fetchPing(id: number, hours = HOURS) {
  const key = `${id}:${hours}`
  if (inflight.has(key)) return
  inflight.add(key)
  queue.push(() => load(id, hours, 0))
  pump()
}

/** One node's probe history, refreshed once a minute while the card is on screen. */
export function useNodePing(id: number, hours = HOURS, enabled = true): Entry | undefined {
  const key = `${id}:${hours}`
  const entry = useSyncExternalStore(
    channel(key).subscribe,
    () => cache.get(key),
    () => cache.get(key),
  )
  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      // A hidden page asks nothing: the figures would be read only on return,
      // where this runs again anyway.
      if (document.hidden) return
      const current = cache.get(key)
      if (!current || Date.now() - current.at >= FRESH) fetchPing(id, hours)
    }
    tick()
    // The ticker exists to notice a card that scrolled into view and the
    // minute going by; a timer here is cheaper than a timer per card.
    const timer = setInterval(tick, 10_000)
    document.addEventListener("visibilitychange", tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [id, hours, key, enabled])
  return entry
}
