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
 */
export function useLiveSamples(nodeId: number, metrics: Metrics | null, seed: LiveRow[] = []): LiveRow[] {
  const [state, setState] = useState<{ id: number; rows: LiveRow[] }>({ id: nodeId, rows: [] })

  useEffect(() => {
    if (!metrics && !seed.length) return
    // oxlint-disable-next-line react/set-state-in-effect
    setState((prev) => {
      const base = prev.id === nodeId ? prev.rows : []
      const seeded = seed.length ? mergeSeed(base, seed) : base
      return { id: nodeId, rows: metrics ? appendLive(seeded, metrics, Date.now()) : seeded }
    })
  }, [nodeId, metrics, seed])

  return state.id === nodeId ? state.rows : []
}

/** Seed from history and live samples, one row per timestamp, oldest first. */
function mergeSeed(base: LiveRow[], seed: LiveRow[]): LiveRow[] {
  const rows = new Map<number, LiveRow>()
  for (const row of [...seed, ...base]) rows.set(row.ts, row)
  return [...rows.values()].sort((a, b) => a.ts - b.ts).slice(-LIVE_CAP)
}
