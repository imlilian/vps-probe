import { despike, despikeWindow } from "./format.ts"

/** A latency bucket as the hub sends it, after the timestamps were made ms. */
export type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}

export type ProbeSeries = {
  id: number
  name: string
  points: PingPoint[]
  /** The hub's sample-weighted window loss, not an average of bucket percentages. */
  loss: number
}

export type ProbeStat = {
  id: number
  name: string
  avg: number | null
  latest: number | null
  min: number | null
  max: number | null
  p50: number | null
  p99: number | null
  volatility: number | null
  loss: number
  samples: number
  valid: number
}

/** Linear-interpolated quantile on a sorted copy, like the reference's P50/P99. */
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo)
}

/**
 * The card's numbers. The hub gives one median per bucket, not every round
 * trip, so these are statistics of the medians: the average of the trend, its
 * P50/P99, and how much the tail moves relative to the middle. The window loss
 * comes from the hub's sample counts and is exact.
 */
export function probeStats(series: ProbeSeries): ProbeStat {
  const values = series.points
    .map((point) => point.latency)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const sorted = [...values].sort((a, b) => a - b)
  const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const p50 = quantile(sorted, 0.5)
  const p99 = quantile(sorted, 0.99)
  const latest = values.length ? values[values.length - 1]! : null
  return {
    id: series.id,
    name: series.name,
    avg,
    latest,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    p50,
    p99,
    volatility: p50 !== null && p50 > 0 && p99 !== null ? p99 / p50 : null,
    loss: series.loss,
    samples: series.points.length,
    valid: values.length,
  }
}

/**
 * Fill short null runs between two answers, the way the reference interpolates
 * gaps smaller than six buckets (clamped to 2–30 minutes). A longer run is an
 * outage and stays null, so the line breaks.
 */
export function interpolateShortGaps(points: PingPoint[], stepMs: number): PingPoint[] {
  const maxGap = Math.min(30 * 60_000, Math.max(2 * 60_000, stepMs * 6))
  const out = points.map((point) => ({ ...point }))
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.latency !== null) continue
    let before = i - 1
    while (before >= 0 && out[before]!.latency === null) before--
    let after = i + 1
    while (after < out.length && out[after]!.latency === null) after++
    if (before < 0 || after >= out.length) continue
    const span = out[after]!.ts - out[before]!.ts
    if (!(span > 0) || span > maxGap) continue
    const ratio = (out[i]!.ts - out[before]!.ts) / span
    const low = out[before]!.latency!
    const high = out[after]!.latency!
    out[i]!.latency = low + (high - low) * ratio
  }
  return out
}

export type LatencyRow = { ts: number } & Record<string, number | [number, number] | null>

/**
 * One row per timestamp, with each probe in its own columns. `t` is the line,
 * `s` the despiked line, `b`/`c` the band before/after the filter, `l` the
 * bucket's loss. The chart selects a column; the array never changes identity
 * when a probe is hidden.
 */
export function buildLatencyRows(series: ProbeSeries[], smooth: boolean, stepMs: number): LatencyRow[] {
  const rows = new Map<number, LatencyRow>()
  for (const probe of series) {
    const points = interpolateShortGaps(probe.points, stepMs)
    const window = despikeWindow(points)
    const line = smooth ? despike(points.map((point) => point.latency), window) : points.map((point) => point.latency)
    const low = smooth ? despike(points.map((point) => point.band?.[0] ?? point.latency), window) : []
    const high = smooth ? despike(points.map((point) => point.band?.[1] ?? point.latency), window) : []

    points.forEach((point, i) => {
      const row = rows.get(point.ts) ?? { ts: point.ts }
      row[`t${probe.id}`] = point.latency
      row[`s${probe.id}`] = line[i] ?? null
      row[`l${probe.id}`] = point.loss ?? 0
      row[`b${probe.id}`] = point.band ?? (point.latency === null ? null : [point.latency, point.latency])
      if (smooth) {
        const lo = low[i] ?? null
        const hi = high[i] ?? null
        const mid = line[i] ?? null
        row[`c${probe.id}`] = lo === null || hi === null || mid === null
          ? null
          : [Math.min(lo, hi, mid), Math.max(lo, hi, mid)]
      }
      rows.set(point.ts, row)
    })
  }
  return [...rows.values()].sort((a, b) => a.ts - b.ts)
}
