import { useEffect, useState } from "react"

import type { Metrics } from "./api.ts"

/** One live sample, in the shape the chart rows use. */
export type LiveRow = {
  ts: number
  cpu: number
  mem_used: number
  swap_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  tcp: number
  udp: number
  procs: number
}

/** Five minutes at the stream's two-second cadence. */
export const LIVE_CAP = 150

/**
 * Where a pushed sample belongs on the time axis: the millisecond the hub built
 * the frame, or the browser's clock for a hub that does not say.
 *
 * The history rows arrive stamped by the hub, so borrowing the browser's clock
 * for the newest samples mixes two clocks on one axis -- a visitor a minute
 * behind draws a line that runs backwards into the seeded buckets, and the
 * dedupe below then eats the first samples instead of appending them. A hub
 * from before the field falls back, which is the old behaviour exactly.
 */
export function frameStamp(at: number): number {
  return Number.isFinite(at) && at > 0 ? at : Date.now()
}

/** A history bucket in the shape a live row uses; the timestamps are both ms. */
export function toLive(row: {
  ts: number
  cpu: number
  mem_used: number
  swap_used?: number
  disk_used: number
  net_rx: number
  net_tx: number
  tcp?: number
  udp?: number
  procs?: number
}): LiveRow {
  return {
    ts: row.ts,
    cpu: row.cpu,
    mem_used: row.mem_used,
    swap_used: row.swap_used ?? 0,
    disk_used: row.disk_used,
    net_rx: row.net_rx,
    net_tx: row.net_tx,
    tcp: row.tcp ?? 0,
    udp: row.udp ?? 0,
    procs: row.procs ?? 0,
  }
}

/**
 * Append one pushed sample. A repeated timestamp replaces the last row rather
 * than drawing two points on one x; the cap keeps the buffer five minutes wide.
 */
export function appendLive(rows: LiveRow[], metrics: Metrics, ts: number): LiveRow[] {
  const row: LiveRow = {
    ts,
    cpu: metrics.cpu,
    mem_used: metrics.mem_used,
    swap_used: metrics.swap_used,
    disk_used: metrics.disk_used,
    net_rx: metrics.net_rx,
    net_tx: metrics.net_tx,
    tcp: metrics.tcp,
    udp: metrics.udp,
    procs: metrics.procs,
  }
  const last = rows.at(-1)
  const next = last && ts <= last.ts ? [...rows.slice(0, -1), row] : [...rows, row]
  return next.slice(-LIVE_CAP)
}

/**
 * The five-minute trace behind the 实时 range. The node prop is a new object on
 * every push, so the effect appends on each render that actually carries a
 * sample; the state carries the node id so switching machines starts empty.
 *
 * Passed `metrics` of null it does nothing at all: the historical ranges draw
 * buckets from the hub and have no use for a live buffer, and filling one behind
 * their back re-renders the six charts every two seconds for nothing.
 */
export function useLiveSamples(
  nodeId: number,
  metrics: Metrics | null,
  /** The frame's own millisecond, from the hub; 0 when it does not send one. */
  at = 0,
  seed: LiveRow[] = [],
): LiveRow[] {
  const [state, setState] = useState<{ id: number; rows: LiveRow[] }>({ id: nodeId, rows: [] })

  useEffect(() => {
    if (!metrics && !seed.length) return
    // oxlint-disable-next-line react/set-state-in-effect
    setState((prev) => {
      const base = prev.id === nodeId ? prev.rows : []
      const seeded = seed.length ? mergeSeed(base, seed) : base
      return { id: nodeId, rows: metrics ? appendLive(seeded, metrics, frameStamp(at)) : seeded }
    })
  }, [nodeId, metrics, at, seed])

  return state.id === nodeId ? state.rows : []
}

/** Seed from history and live samples, one row per timestamp, oldest first. */
function mergeSeed(base: LiveRow[], seed: LiveRow[]): LiveRow[] {
  const rows = new Map<number, LiveRow>()
  for (const row of [...seed, ...base]) rows.set(row.ts, row)
  return [...rows.values()].sort((a, b) => a.ts - b.ts).slice(-LIVE_CAP)
}
