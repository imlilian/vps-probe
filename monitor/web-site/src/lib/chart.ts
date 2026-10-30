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
 * The stacked panels' value axes, and the reason they are `auto` rather than a
 * constant.
 *
 * A number here is not only the column's width: recharts hands it to its tick
 * text as the width the text may occupy, and it *measures* the strings at the
 * font size they inherit -- the card's 16px -- while the axis *draws* them at
 * 11. `512 MB` is 39px on screen and 57px to the measurer, so a 56px column
 * wrapped it onto two lines, and the network card's `100 MB/s` -- 70 to the
 * measurer -- was cut by the plot's top edge because a wrapped label is two
 * lines tall. `auto` measures the labels as drawn: nothing wraps, and the
 * column is the widest label plus the 8px of tick spacing.
 *
 * The overhang this leaves for the first clock tick's half-label is why the
 * chart's own left margin is 0 (see `MARGIN`): that half falls into the axis's
 * column, where the baseline label would have been -- and the baseline label is
 * gone, `hideZero`.
 */
export const VALUE_AXIS = { ...AXIS, width: "auto", interval: 0 } as const

/**
 * The box the plot has inside the card.
 *
 * `top` and not recharts' 5: the top gridline's label is centred on the line, so
 * half of its 11px stands above the plot, and at 5 the top of `100%` was
 * clipped by the SVG's edge. `left: 0` gives the drawing the 5px recharts
 * reserves there -- the Y labels are right-aligned against the plot, and the
 * first time label's overhang is absorbed by the axis's own column. The right
 * and bottom margins stay: they are what keeps the *last* clock tick's label
 * inside the drawing.
 */
export const MARGIN = { top: 9, right: 5, bottom: 5, left: 0 } as const

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
 * How many clock labels fit across a plot `plotWidth` px wide.
 *
 * One per 66px, which is `21:30` at 30px of 11px text plus the 34px the axis
 * keeps between labels (see `minTickGap` in `timeAxis`). Eight of them need
 * 528px, so a desktop panel's plot -- 570-odd -- keeps the eight half-hours it
 * has always drawn, and a phone's 270 keeps four hours.
 *
 * Below the desktop width it matters. Handed eight ticks, recharts keeps the
 * ones that fit and drops the rest working in from the right, so a phone's
 * four-hour panel came out `22:00 23:30 01:00`: unevenly spaced, and missing the
 * midnight that is the one label a reader looks for. Asking for the number that
 * fits makes `timeTicks` choose a whole-hour step instead, and then every label
 * it draws is a label it kept.
 */
export const tickCount = (plotWidth: number) => Math.min(8, Math.max(2, Math.round(plotWidth / 66)))

/**
 * A real time axis rather than recharts' category axis: ticks are placed on
 * clock boundaries, and an offline stretch is a gap rather than a collapsed
 * category.
 */
export function timeAxis(rows: { ts: number }[], hours: number, count = 8) {
  const ticks = rows.length ? timeTicks(rows[0].ts, rows[rows.length - 1].ts, count) : []
  return {
    dataKey: "ts",
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as const,
    ticks,
    tickFormatter: tickClock(ticks, hours),
    minTickGap: hours > 24 ? 72 : 34,
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
