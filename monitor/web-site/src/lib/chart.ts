import { tickClock, timeTicks } from "./format.ts"

/** The series colours, one place, all from the chart tokens. */
export const COLOR = {
  cpu: "var(--color-chart-5)",
  mem: "var(--color-chart-5)",
  memTotal: "var(--color-chart-1)",
  swap: "var(--color-chart-6)",
  swapTotal: "var(--color-chart-4)",
  disk: "var(--color-chart-3)",
  diskTotal: "var(--color-chart-1)",
  down: "var(--color-chart-1)",
  up: "var(--color-chart-4)",
  tcp: "var(--color-chart-5)",
  udp: "var(--color-chart-3)",
  proc: "var(--color-chart-4)",
} as const

export const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false } as const

/** One width for the stacked panels' value axes; the widest label is `100 MB/s`. */
export const VALUE_AXIS = { ...AXIS, width: 68, interval: 0 } as const

/** The grid and crosshair the panels share; `2 4` at the hairline token. */
export const GRID = { strokeDasharray: "2 4", className: "stroke-border-soft", vertical: false } as const
export const CURSOR = { stroke: "var(--border)", strokeDasharray: "3 3" } as const

/** Charts do not animate: a range change redraws hundreds of points. */
export const LINE = {
  dot: false as const,
  strokeWidth: 1.5,
  isAnimationActive: false,
  type: "monotone" as const,
} as const

/** A total or a peak: thinner and dashed, so hue is still the only series cue. */
export const DERIVED = {
  ...LINE,
  strokeWidth: 1.2,
  strokeDasharray: "6 3",
} as const

/** A hairline peak line, per the reference's `width: 1, opacity: .6`. */
export const PEAK = {
  ...LINE,
  strokeWidth: 1,
  strokeOpacity: 0.6,
  strokeDasharray: "6 3",
} as const

export const CPU_TICKS = [0, 20, 40, 60, 80, 100]

export const TOOLTIP = {
  isAnimationActive: false,
  cursor: CURSOR,
  labelFormatter: (ts: unknown) => new Date(Number(ts)).toLocaleString("zh-CN"),
  contentStyle: {
    fontSize: 12,
    background: "var(--card)",
    backdropFilter: "blur(10px)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    color: "var(--foreground)",
  },
  labelStyle: { color: "var(--muted-foreground)", marginBottom: 4 },
  itemStyle: { color: "var(--foreground)" },
} as const

/**
 * A real time axis rather than recharts' category axis: ticks are placed on
 * clock boundaries, and an offline stretch is a gap rather than a collapsed
 * category.
 */
export function timeAxis(rows: { ts: number }[], hours: number) {
  const ticks = rows.length ? timeTicks(rows[0].ts, rows[rows.length - 1].ts) : []
  return {
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    ticks,
    tickFormatter: tickClock(ticks, hours),
    minTickGap: hours > 24 ? 72 : 40,
    ...AXIS,
  }
}
