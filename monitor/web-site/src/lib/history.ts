import { useEffect, useLayoutEffect, useState } from "react"
import type { RefObject } from "react"

import { api } from "./api.ts"
import { peakOf, type PeakRow } from "./detail.ts"
import type { PingPoint } from "./pingDetail.ts"
import { metricsPath } from "./sampling.ts"

/** A metrics row as the charts draw it: epoch milliseconds, bucket means and maxima. */
export type MetricPoint = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  /** The bucket's highest rate, never below its mean; absent from old hubs. */
  net_rx_max?: number
  net_tx_max?: number
  /** The bucket's highest CPU; absent before hub 1.3.2. */
  cpu_max?: number
  swap_used?: number
  tcp?: number
  udp?: number
  procs?: number
  /** Minutes with a row in the bucket; absent from old hubs. */
  minutes?: number
}

type MetricsAnswer = { metrics?: MetricPoint[]; step?: number }
type PingAnswerBody = {
  ping?: PingPoint[]
  probes?: Record<string, string>
  loss?: Record<string, number>
  step?: number
}
type PeakAnswer = { metrics?: PeakRow[] }

type MetricsState = { url: string; rows: MetricPoint[]; step: number; error: string }
type PingState = {
  url: string
  rows: PingPoint[]
  probes: Record<string, string>
  loss: Record<string, number>
  step: number
  error: string
}

/**
 * History answers are shared, not repeated.
 *
 * A hub runs four history scans at a time for the whole machine (its
 * `HISTORY_SLOTS`), and one visit to a node's page asks for two of them before
 * the first paint. Two readers on one node would therefore sit on the whole
 * gate, and a third would be told to come back later. The answers are the same
 * for every reader and change by the bucket, so one request is kept for half a
 * minute and handed to everyone who asks for the same URL meanwhile -- a second
 * visitor, a range switched away from and back, a remount of the page.
 *
 * A failed request is not kept: the retry button must reach the hub.
 */
const AGE = 30_000
/** Two dozen windows: a node's five load ranges, six ping ranges, its peaks. */
const HELD = 24
const answers = new Map<string, { at: number; value: unknown }>()
/** One request per URL while it is in flight, however many callers ask. */
const pending = new Map<string, Promise<unknown>>()

function hold(url: string, value: unknown) {
  answers.delete(url)
  answers.set(url, { at: Date.now(), value })
  while (answers.size > HELD) {
    const oldest = answers.keys().next()
    if (oldest.done) break
    answers.delete(oldest.value)
  }
}

/** What is already known, without a request: the render-time half of the cache. */
export function historyPeek<T>(url: string, age = AGE): T | undefined {
  const held = answers.get(url)
  return held && Date.now() - held.at < age ? held.value as T : undefined
}

export function historyGet<T>(url: string, age = AGE): Promise<T> {
  const held = historyPeek<T>(url, age)
  if (held !== undefined) return Promise.resolve(held)
  const running = pending.get(url)
  if (running) return running as Promise<T>
  const request = api<T>(url)
    .then((value) => {
      hold(url, value)
      return value
    })
    .finally(() => {
      pending.delete(url)
    })
  pending.set(url, request)
  return request
}

/** A hub answer as the charts read it: epoch milliseconds, and a missing step as none. */
function toMetrics(answer: MetricsAnswer): { rows: MetricPoint[]; step: number } {
  return {
    rows: (answer.metrics ?? []).map((row) => ({ ...row, ts: row.ts * 1000 })),
    step: answer.step ?? 0,
  }
}

function toPing(answer: PingAnswerBody) {
  return {
    rows: (answer.ping ?? []).map((row) => ({ ...row, ts: row.ts * 1000 })),
    probes: answer.probes ?? {},
    loss: answer.loss ?? {},
    step: answer.step ?? 0,
  }
}

/**
 * The load charts' history: one request per range, with the point count coming
 * from the time-bucket table rather than the panel's pixel width. The hub does
 * the aggregation; this hook only carries the rows and distinguishes "loading"
 * from "loaded empty". A range switched back to within the cache's age draws at
 * once -- no skeleton, and no second scan behind the gate.
 */
export function useMetricsHistory(nodeId: number, hours: number, enabled = true) {
  const url = enabled && hours > 0 ? metricsPath(nodeId, hours, "load") : ""
  const [state, setState] = useState<MetricsState>(() => {
    const held = url ? historyPeek<MetricsAnswer>(url) : undefined
    return held ? { url, ...toMetrics(held), error: "" } : { url: "", rows: [], step: 0, error: "" }
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!url) return
    let active = true
    historyGet<MetricsAnswer>(url)
      .then((answer) => {
        if (active) setState({ url, ...toMetrics(answer), error: "" })
      })
      .catch((error: Error) => {
        if (active) setState({ url, rows: [], step: 0, error: error.message })
      })
    return () => {
      active = false
    }
  }, [url, attempt])

  const data = state.url === url ? state : null
  return {
    rows: data?.rows ?? [],
    step: data?.step ?? 0,
    error: data?.error ?? "",
    loading: Boolean(url) && !data,
    retry: () => setAttempt((n) => n + 1),
  }
}

export type PingAnswer = {
  rows: PingPoint[]
  probes: Record<string, string>
  loss: Record<string, number>
  step: number
  error: string
  loading: boolean
  retry: () => void
}

/**
 * The latency half's history: one request, `points` from the ping bucket table.
 * Timestamps are normalized to milliseconds and the hub's window loss is passed
 * through untouched -- it is the only figure computed from sample counts, and
 * averaging per-bucket percentages would lose exactly that.
 */
export function usePingHistory(nodeId: number, hours: number, enabled = true): PingAnswer {
  const url = enabled && hours > 0 ? metricsPath(nodeId, hours, "ping") : ""
  const [state, setState] = useState<PingState>(() => {
    const held = url ? historyPeek<PingAnswerBody>(url) : undefined
    return held
      ? { url, ...toPing(held), error: "" }
      : { url: "", rows: [], probes: {}, loss: {}, step: 0, error: "" }
  })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!url) return
    let active = true
    historyGet<PingAnswerBody>(url)
      .then((answer) => {
        if (active) setState({ url, ...toPing(answer), error: "" })
      })
      .catch((error: Error) => {
        if (active) setState({ url, rows: [], probes: {}, loss: {}, step: 0, error: error.message })
      })
    return () => {
      active = false
    }
  }, [url, attempt])

  const data = state.url === url ? state : null
  return {
    rows: data?.rows ?? [],
    probes: data?.probes ?? {},
    loss: data?.loss ?? {},
    step: data?.step ?? 0,
    error: data?.error ?? "",
    loading: Boolean(url) && !data,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** The CSS width of a chart grid, for the render-layer guard (not the request). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(Math.round(el.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

export type Peak = { rx: number; tx: number }

// A day's peak moves slowly enough that five minutes is fresh. It lives in the
// shared cache above, under the same URL, so two cards or two visits cost one
// request rather than one each.
const PEAK_AGE = 5 * 60_000
const peakUrl = (nodeId: number) => metricsPath(nodeId, 24, "load", 24)

/** The peak already known for a node: one hour per bucket is enough for a max. */
function peakOfUrl(url: string): Peak | null {
  const held = historyPeek<PeakAnswer>(url, PEAK_AGE)
  return held ? peakOf(held.metrics ?? []) : null
}

/**
 * The highest transfer rate each way over the last day, for the network card's
 * third line. Twenty-four one-hour buckets: the hub's `net_*_max` is itself a
 * maximum of maxima, so a finer grid cannot raise it. Failure is silent -- the
 * line simply does not appear.
 */
export function useDayPeak(nodeId: number): Peak | null {
  const url = peakUrl(nodeId)
  // The state is tagged with the node it belongs to, so a switch to another
  // machine reads as "no peak yet" without a synchronous setState in the
  // effect; a cached answer is read during render instead.
  const [state, setState] = useState<{ id: number; peak: Peak | null }>(() => ({
    id: nodeId,
    peak: peakOfUrl(url),
  }))
  const current = peakOfUrl(url) ?? (state.id === nodeId ? state.peak : null)

  useEffect(() => {
    if (peakOfUrl(url)) return
    let active = true
    historyGet<PeakAnswer>(url, PEAK_AGE)
      .then((answer) => {
        if (active) setState({ id: nodeId, peak: peakOf(answer.metrics ?? []) })
      })
      .catch(() => {
        if (active) setState({ id: nodeId, peak: null })
      })
    return () => {
      active = false
    }
  }, [nodeId, url])

  return current
}
