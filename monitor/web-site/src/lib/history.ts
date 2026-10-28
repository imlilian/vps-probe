import { useEffect, useState } from "react"

import { api } from "./api.ts"
import { peakOf, type PeakRow } from "./detail.ts"

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
