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

/**
 * The stacked panels' value axes.
 *
 * 56 and not `auto`. `auto` fits the axis to its own labels and nothing more,
 * which sounds ideal and is not: the first clock tick of the X axis sits at the
 * plot's left edge, its label centred on it, so half that label falls in the
 * axis's column -- with the column exactly as wide as the Y labels, the two sets
 * of text land on top of each other and the time looks like it was dropped. The
 * axis keeps a few pixels of room for its neighbour, which is also why it is not
 * the 68 it started as: `100 MB` needs 44, and the rest was a phone's fifth of
 * the drawing.
 */
export const VALUE_AXIS = { ...AXIS, width: 56, interval: 0 } as const

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

/**
 * A tick that prints nothing at the baseline.
 *
 * Every one of these cards has a time label in the corner below the axis, and a
 * `0 B` printed at that same corner is two labels fighting for one gap -- which
 * is what made `20:30` look shoved up against `0 B`. The baseline itself stays,
 * because an area chart that does not start at zero lies about the fill; only its
 * label goes, which is what charts on the web do everywhere.
 */
export const hideZero = (format: (value: number) => string) => (value: unknown) =>
  Number(value) === 0 ? "" : format(Number(value))

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

/** Probe colours in reading order: five hues solid, then the same five dashed. */
const PROBE_STYLES = [
  { stroke: "var(--color-chart-1)", dash: undefined },
  { stroke: "var(--color-chart-3)", dash: undefined },
  { stroke: "var(--color-chart-2)", dash: undefined },
  { stroke: "var(--color-chart-4)", dash: undefined },
  { stroke: "var(--color-chart-5)", dash: undefined },
  { stroke: "var(--color-chart-1)", dash: "6 3" },
  { stroke: "var(--color-chart-3)", dash: "6 3" },
  { stroke: "var(--color-chart-2)", dash: "6 3" },
  { stroke: "var(--color-chart-4)", dash: "6 3" },
  { stroke: "var(--color-chart-5)", dash: "6 3" },
] as const

export function probeStyle(index: number) {
  return PROBE_STYLES[index % PROBE_STYLES.length]!
}
