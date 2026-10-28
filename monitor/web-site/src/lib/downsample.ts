/// <reference types="node" />
// Largest-Triangle-Three-Buckets, over rows that may contain a hole.
//
// The chart asks the hub for one sample per CSS pixel, and the hub rounds that
// up into whole minutes, so the response is already within the budget. This is
// the second gate: the frontend ships independently of the hub, and a hub that
// predates `points` -- or a response already in flight when the window was
// dragged narrower -- still arrives at 1,440 rows. Rendering is where the
// invariant has to hold, so it is enforced here rather than assumed of the wire.
//
// A hole is not a null in the data but a row with only `ts`: `withGaps` inserts
// one where the node was silent, and recharts reads its missing fields as a
// break. Those rows are carried through untouched and split the series, since a
// pick that reached across one would draw a line through an outage.

export type Point = { ts: number }

/**
 * How many samples a panel of `width` CSS pixels should be handed: one per
 * pixel, split across `cols` columns with `gap` between them, and never more
 * than the hub will answer.
 *
 * A line is measured in CSS pixels, so that is the unit a window has to arrive
 * in. Asking for `innerWidth × devicePixelRatio` counts the pixels the line is
 * *rasterized* into instead: a 1440-wide retina panel asked for 2,880, the hub
 * capped at 1,440, and those landed in a 670-pixel column at 2.15 samples per
 * pixel -- a band of noise rather than a line. More dots per inch do not make
 * this sharper; they make it denser.
 *
 * The 240 floor keeps a phone's window from arriving in so few samples that a
 * short spike is dropped between two of them, at the cost of a slight overlap
 * on the narrowest screen; the ceiling is what the hub promises, not the panel.
 */
export function samples(width: number, cols: number, gap: number, ceiling: number): number {
  if (!(width > 0) || cols < 1) return 0
  const panel = (width - (cols - 1) * gap) / cols
  return Math.min(ceiling, Math.max(240, Math.round(panel)))
}

/**
 * The triangle test needs a number per row. `null` and `undefined` both mean
 * "no reading here" -- the former from a probe that timed out, the latter from
 * every metric field of a gap row.
 */
export type Value<T> = (row: T) => number | null | undefined

/** A run of consecutive readings, or one hole standing on its own. */
type Segment = { from: number; to: number } | { hole: number }

function segments<T>(rows: readonly T[], values: readonly Value<T>[]): Segment[] {
  const out: Segment[] = []
  let start = -1
  const empty = (row: T) => values.every((value) => {
    const v = value(row)
    return v == null || !Number.isFinite(v)
  })
  rows.forEach((row, i) => {
    if (empty(row)) {
      if (start >= 0) out.push({ from: start, to: i })
      start = -1
      out.push({ hole: i })
      return
    }
    if (start < 0) start = i
  })
  if (start >= 0) out.push({ from: start, to: rows.length })
  return out
}

/**
 * The indices of `keep` readings out of one uninterrupted run: the ends, plus
 * the corner of each bucket that makes the largest triangle with the last pick
 * and the mean of the next bucket. A peak is always the far corner, which is
 * why it survives here and does not survive averaging a bucket.
 */
function picksRun<T extends Point>(rows: readonly T[], from: number, to: number, keep: number, value: Value<T>): number[] {
  const length = to - from
  if (keep >= length || length <= 2) return Array.from({ length }, (_, i) => from + i)

  const out: number[] = [from]
  const every = (length - 2) / (keep - 2)
  let a = from

  for (let i = 0; i < keep - 2; i++) {
    // The bucket to choose from, and the one after it, whose mean is the third
    // vertex of the triangle.
    const at = from + Math.floor(i * every) + 1
    const end = Math.min(from + Math.floor((i + 1) * every) + 1, to - 1)
    const nextFrom = Math.min(from + Math.floor((i + 1) * every) + 1, to - 1)
    const nextTo = Math.min(from + Math.floor((i + 2) * every) + 1, to)

    let sumX = 0
    let sumY = 0
    for (let j = nextFrom; j < nextTo; j++) {
      sumX += rows[j].ts
      sumY += value(rows[j]) ?? 0
    }
    const span = Math.max(1, nextTo - nextFrom)
    const ax = rows[a].ts
    const ay = value(rows[a]) ?? 0
    const bx = sumX / span
    const by = sumY / span

    let best = at
    let most = -1
    for (let j = at; j < Math.max(end, at + 1); j++) {
      const area = Math.abs((ax - bx) * ((value(rows[j]) ?? 0) - ay) - (ax - rows[j].ts) * (by - ay))
      if (area > most) {
        most = area
        best = j
      }
    }
    out.push(best)
    a = best
  }

  out.push(to - 1)
  return out
}

/**
 * The rows to draw: the union of what each series would keep on its own.
 *
 * The four resource panels share one row set, so thinning on CPU alone would
 * cut the network panel's peaks -- a transfer rate has nothing to do with the
 * scheduler. Every series gets a vote, and a row kept by any of them is kept.
 */
export function lttb<T extends Point>(rows: readonly T[], threshold: number, values: Value<T> | Value<T>[]): T[] {
  const all = Array.isArray(values) ? values : [values]
  const runs = segments(rows, all)
  const readings = runs.reduce((n, s) => n + ("hole" in s ? 0 : s.to - s.from), 0)
  // Nothing to do: the window fits, or it is too short for the triangle test to
  // say anything useful about it.
  if (readings <= threshold || threshold < 3) return rows.slice()

  const keep = new Set<number>()
  for (const run of runs) {
    if ("hole" in run) {
      keep.add(run.hole)
      continue
    }
    const length = run.to - run.from
    // Each run's share of the budget, with a floor of three so a run spanning a
    // gap still keeps its shape, and never more rows than it has.
    const share = Math.min(length, Math.max(3, Math.round(threshold * length / readings)))
    for (const value of all) for (const i of picksRun(rows, run.from, run.to, share, value)) keep.add(i)
  }

  return [...keep].sort((a, b) => a - b).map((i) => rows[i])
}

/**
 * The render-layer guard: thin a row set to `budget` while keeping every
 * series' shape.
 *
 * `lttb` alone takes a union of what each series would keep, which is right for
 * preserving peaks but can land at several times the budget. `decimate` gives
 * each series its own share first, then adds the endpoints, holes and each
 * series' maximum. It is only used when the time buckets still exceed what the
 * panel can draw -- an old hub, or a very narrow screen -- not on every range.
 */
export function decimate<T extends Point>(rows: readonly T[], budget: number, values: Value<T> | Value<T>[]): T[] {
  const all = Array.isArray(values) ? values : [values]
  if (!(budget > 0) || rows.length <= budget) return rows.slice()

  const usable = all.filter((value) => rows.some((row) => {
    const v = value(row)
    return v != null && Number.isFinite(v)
  }))
  if (!usable.length) return rows.slice(0, budget)

  const per = Math.max(3, Math.floor((budget - 2) / usable.length))
  const index = new Map<number, number>()
  rows.forEach((row, i) => index.set(row.ts, i))
  const keep = new Set<number>()

  for (const value of usable) {
    for (const row of lttb(rows, per, value)) {
      const i = index.get(row.ts)
      if (i !== undefined) keep.add(i)
    }
    let top = -Infinity
    let at = -1
    rows.forEach((row, i) => {
      const v = value(row)
      if (v != null && Number.isFinite(v) && v > top) {
        top = v
        at = i
      }
    })
    if (at >= 0) keep.add(at)
  }
  for (const run of segments(rows, usable)) if ("hole" in run) keep.add(run.hole)

  return [...keep].sort((a, b) => a - b).map((i) => rows[i]!)
}
