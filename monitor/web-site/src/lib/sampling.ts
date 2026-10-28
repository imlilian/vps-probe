/**
 * How many points to ask the hub for, by *time* rather than by pixel.
 *
 * The hub buckets raw minute rows in SQL (`step = unit * ceil(window/unit/points)`),
 * so `points` is the one knob that decides the data's resolution. Asking for one
 * point per CSS pixel was the mistake behind the seven-day noise: a 636px panel
 * requested 630 buckets of sixteen minutes. These tables request a bucket that
 * matches the range's question instead, and every screen then sees the same
 * data.
 */
export type SamplingKind = "load" | "ping"

/** Load: 4h = 1 minute, 1d = 10 minutes, 7d = 1 hour, 30d = 4 hours. */
const LOAD_BUCKETS: Record<number, number> = { 4: 60, 24: 600, 168: 3_600, 720: 14_400 }

/** Latency: 1h = 1m, 6h = 2m, 12h = 5m, 1d = 10m, 7d = 1h, 30d = 4h. */
const PING_BUCKETS: Record<number, number> = {
  1: 60, 6: 120, 12: 300, 24: 600, 168: 3_600, 720: 14_400,
}

/**
 * The bucket for a range, in seconds. An unknown range (a custom window, or a
 * hub with a shorter retention) takes the next table stop up, so it is never
 * finer than the table promises.
 */
export function bucketFor(hours: number, kind: SamplingKind): number {
  const table = kind === "load" ? LOAD_BUCKETS : PING_BUCKETS
  if (table[hours]) return table[hours]
  const stops = Object.keys(table).map(Number).sort((a, b) => a - b)
  const stop = stops.find((h) => h >= hours) ?? stops.at(-1)!
  return table[stop]!
}

/** The `points` query value for a window: the fewest buckets that cover it. */
export function pointsFor(hours: number, kind: SamplingKind): number {
  return Math.max(1, Math.ceil((hours * 3_600) / bucketFor(hours, kind)))
}

/**
 * The render-layer guard: a panel can draw about one point per 1.33px before
 * the eye reads a line as a texture. The time buckets above sit below this for
 * every normal width; the guard only catches a very narrow panel or an old hub
 * that ignored `points`.
 */
export function renderBudget(panelWidth: number): number {
  return Math.max(120, Math.round(panelWidth * 0.75))
}

/**
 * The one place the history URL is assembled. `series` is metrics for load and
 * ping for latency; the point count is the time-bucket table's unless a caller
 * states one, never a panel width. Keeping it here makes the request auditable
 * from a test.
 *
 * `points` is the exception for a figure that does not need the table: the
 * network card's 24-hour peak is a maximum of the hub's own bucket maxima, so
 * hourly buckets cannot miss it and a finer grid only costs rows.
 */
export function metricsPath(
  nodeId: number,
  hours: number,
  kind: SamplingKind,
  points = pointsFor(hours, kind),
): string {
  return `/nodes/${nodeId}/metrics?hours=${hours}&points=${points}&series=${kind === "load" ? "metrics" : "ping"}`
}
