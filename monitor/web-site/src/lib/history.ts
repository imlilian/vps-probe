import { useEffect, useLayoutEffect, useState } from "react"
import type { RefObject } from "react"

import { api } from "./api.ts"
import { peakOf, type PeakRow } from "./detail.ts"
import { pointsFor } from "./sampling.ts"

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

type HistoryState = {
  key: string
  rows: MetricPoint[]
  step: number
  error: string
}

/**
 * The load charts' history: one request per range, with the point count coming
 * from the time-bucket table rather than the panel's pixel width. The hub does
 * the aggregation; this hook only carries the rows and distinguishes "loading"
 * from "loaded empty".
 */
export function useMetricsHistory(nodeId: number, hours: number, enabled = true) {
  const key = enabled && hours > 0 ? `${nodeId}:${hours}:${pointsFor(hours, "load")}` : ""
  const [state, setState] = useState<HistoryState>({ key: "", rows: [], step: 0, error: "" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || hours <= 0) return
    let active = true
    api<{ metrics?: MetricPoint[]; step?: number }>(
      `/nodes/${nodeId}/metrics?hours=${hours}&points=${pointsFor(hours, "load")}&series=metrics`,
    )
      .then((answer) => {
        const rows = (answer.metrics ?? []).map((row) => ({ ...row, ts: row.ts * 1000 }))
        if (active) setState({ key, rows, step: answer.step ?? 0, error: "" })
      })
      .catch((error: Error) => {
        if (active) setState({ key, rows: [], step: 0, error: error.message })
      })
    return () => {
      active = false
    }
  }, [nodeId, hours, enabled, key, attempt])

  const data = state.key === key ? state : null
  return {
    rows: data?.rows ?? [],
    step: data?.step ?? 0,
    error: data?.error ?? "",
    loading: Boolean(enabled && hours > 0 && !data),
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

// A day's peak moves slowly enough that five minutes is fresh. The detail page
// can mount this card again after a route change, and a second request for the
// same node would spend one of the hub's four history slots for a figure that
// has not changed.
const TTL = 5 * 60_000
const CACHE = new Map<number, { at: number; value: Peak }>()

/**
 * The highest transfer rate each way over the last day, for the network card's
 * third line. One hour per bucket is enough for a maximum: the hub's
 * `net_*_max` is itself a maximum of maxima, so a finer grid cannot raise it.
 * Failure is silent -- the line simply does not appear.
 */
export function useDayPeak(nodeId: number): Peak | null {
  // The state is tagged with the node it belongs to, so a switch to another
  // machine reads as "no peak yet" without a synchronous setState in the
  // effect; a cached answer is read during render instead.
  const [state, setState] = useState<{ id: number; peak: Peak | null }>(() => ({
    id: nodeId,
    peak: CACHE.get(nodeId)?.value ?? null,
  }))
  const cached = CACHE.get(nodeId)
  const current = cached && Date.now() - cached.at < TTL
    ? cached.value
    : state.id === nodeId ? state.peak : null

  useEffect(() => {
    const hit = CACHE.get(nodeId)
    if (hit && Date.now() - hit.at < TTL) return
    let active = true
    api<{ metrics?: PeakRow[] }>(`/nodes/${nodeId}/metrics?hours=24&points=24&series=metrics`)
      .then((answer) => {
        const next = peakOf(answer.metrics ?? [])
        if (next) CACHE.set(nodeId, { at: Date.now(), value: next })
        if (active) setState({ id: nodeId, peak: next })
      })
      .catch(() => {
        if (active) setState({ id: nodeId, peak: null })
      })
    return () => {
      active = false
    }
  }, [nodeId])

  return current
}
