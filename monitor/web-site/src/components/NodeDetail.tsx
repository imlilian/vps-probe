import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, Cable, Cpu, HardDrive, MemoryStick, Network } from "lucide-react"
import {
  Area, AreaChart, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, type DotItemDotProps,
} from "recharts"

import { Chip } from "@/components/ui/chip"
import { Glyph } from "@/components/ui/glyph"
import { ChartFade, ChartPanel, CURSOR, GRID } from "@/components/ChartPanel"
import { DetailHeader } from "@/components/detail/DetailHeader"
import { LatencySection } from "@/components/detail/LatencySection"
import { LoadSection } from "@/components/detail/LoadSection"
import { InfoGrid } from "@/components/detail/InfoGrid"
import { MetricGrid } from "@/components/detail/MetricGrid"
import { percentText } from "@/components/Meter"
import { Figure } from "@/components/NodeCard"
import type { Metrics, Node } from "@/lib/api"
import { lttb } from "@/lib/downsample"
import {
  axisBytes, axisTop, bytes, despike,
  percent, quarters, rate, RATE_FLOOR, rateAxis, tickClock, timeTicks, withGaps,
} from "@/lib/format"

type Point = {
  ts: number
  cpu: number
  mem_used: number
  disk_used: number
  net_rx: number
  net_tx: number
  // The highest rate the agent measured over one report interval within the
  // bucket, never below its mean. Absent from hubs predating it.
  net_rx_max?: number
  net_tx_max?: number
  // Socket and process counts. The hub has kept them for as long as this theme
  // has asked; a hub older than that answers without them, which is why the
  // connection panel only appears once one arrives.
  tcp?: number
  udp?: number
  procs?: number
}
const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

/**
 * `percentText` hands back a node -- a hub with no figure shows an em dash --
 * while a chart heading carries a figure and its unit as one string, so `Figure`
 * can split them. Narrowed here once instead of at each of the three headings.
 */
const pctText = (pct: number | null) => String(percentText(pct))

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
//
// `monotone` rather than the default straight segments: at a sample per pixel a
// polyline is a staircase of one-pixel steps, and the eye reads the steps as
// jitter on top of the data. The curve passes through every kept sample, so
// nothing is smoothed away -- `lttb` already decided what survives -- and a null
// still breaks it: `connectNulls` stays false everywhere it was false.
const SERIES = { dot: false as const, strokeWidth: 1.5, isAnimationActive: false, type: "monotone" as const }

// A resource chart's series. A row with a gap on either side has no neighbour to
// draw a line to, so it is marked with a dot; without one, a node back for a
// single bucket after a stretch offline would not show at all.
const RESOURCE_SERIES = {
  ...SERIES,
  dot: ({ cx, cy, index, points, stroke }: DotItemDotProps) =>
    cy == null || points[index - 1]?.y != null || points[index + 1]?.y != null ? null : (
      <circle cx={cx} cy={cy} r={2} fill={stroke} />
    ),
}

// Nor does the tooltip slide. Entering a chart at its right edge, it appears
// beside the cursor first and would glide 400 ms back within the chart,
// overhanging the page by up to 140 px and flashing a horizontal scrollbar.
//
// The box is the card's own surface rather than recharts' white: a tooltip is a
// piece of this page held over the chart, and on the dark theme the default one
// was a white hole in the middle of it.
const TOOLTIP = {
  isAnimationActive: false,
  // The crosshair: a hairline at the cursor, so the reader can carry a value
  // down to the time axis. Dashed and in the border token -- it is a reading
  // aid, not a third series.
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
}

// One width for every stacked panel's value axis. Sized to their own labels --
// 40px under "100%", 68px under "172 MB" -- the four plot areas would be offset by
// 28px, placing a CPU spike and the network spike that caused it at different x.
//
// Every listed tick is drawn: the lists are spaced to fit, while recharts' own
// collision pass would nudge the top label 5 px inward, drop the tick beneath it,
// and thin the gridlines separately -- the CPU axis would lose its 30% gridline,
// and a rate axis of 1 KB/s to 100 MB/s its 10 MB/s label and two gridlines.
const VALUE_AXIS = { ...AXIS, width: 68, interval: 0 }

const CONNS = [
  { key: "tcp", label: "TCP", stroke: "var(--color-chart-1)", dash: undefined },
  { key: "udp", label: "UDP", stroke: "var(--color-chart-3)", dash: undefined },
  { key: "procs", label: "进程", stroke: "var(--color-chart-4)", dash: "5 3" },
] as const

/** A row of the connection chart: the counts, on the panel's own time axis. */
type ConnRow = { ts: number; tcp?: number; udp?: number; procs?: number }

/**
 * A metric row as the four panels draw it: seconds turned into milliseconds,
 * and each rate widened into the band that sits behind its line.
 */
type MetricRow = Point & {
  rx: number
  tx: number
  rx_band: [number, number]
  tx_band: [number, number]
}

/** A legend's sample of the line it names: same hue, same dash. */
function Swatch({ stroke, dash }: { stroke: string; dash?: string }) {
  return (
    <svg width="14" height="6" className="shrink-0" aria-hidden>
      <line x1="0" y1="3" x2="14" y2="3" stroke={stroke} strokeDasharray={dash} strokeWidth="2" />
    </svg>
  )
}

/**
 * How many samples of a probe's own series make up seven minutes of neighbours.
 *
 * The window the filter judges against has to be a duration, not a count: the
 * hub buckets a window to the `points` asked for below, so the same day arrives
 * as one-minute buckets on a desktop and two-minute ones on a phone, and a fixed
 * count would clip a five-minute stall on the first while keeping it on the
 * second. The smallest gap between the probe's samples is its spacing, the
 * bucket or its own interval if longer; a wider one is the node being offline.
 * Odd, so the window has a middle, and bounded so a sparse probe still has
 * neighbours and a dense one does not pay for a wide sort.
 */
function despikeWindow(points: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < points.length; i++) step = Math.min(step, points[i].ts - points[i - 1].ts)
  return Math.min(15, Math.max(3, Math.round(420 / step) | 1))
}

// A real time axis rather than the category axis recharts defaults to: on a
// category axis ticks are selected by index, so a period the agent was offline
// for collapses to nothing.
function timeAxis(rows: { ts: number }[], hours: number, from = 0, to = rows.length - 1) {
  // Explicit, or recharts places them at 05:14 and 10:22. Any that still collide
  // are dropped by `minTickGap`.
  const ticks = rows.length ? timeTicks(rows[from].ts, rows[to].ts) : []
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

/**
 * The sockets and processes a machine is holding, over the window, with the
 * current count on each legend chip -- the legend is the readout, so a figure
 * that changes every two seconds does not need a line of its own.
 *
 * Pressing a chip hides its line; the axis then rescales to the two that remain,
 * which is what makes a quiet UDP count readable beside a busy TCP one.
 */
export function Connections({ rows, hours, live }: {
  rows: ConnRow[]
  hours: number
  /** The node's live sample, for the counts on the chips. */
  live?: Metrics | null
}) {
  const [hidden, setHidden] = useState<string[]>([])
  // The live count where the hub pushed one, and otherwise the newest bucket,
  // which the node has not necessarily filled yet.
  const latest = (key: (typeof CONNS)[number]["key"]) => {
    const now = live?.[key]
    if (typeof now === "number") return now
    for (let i = rows.length - 1; i >= 0; i--) {
      const value = rows[i][key]
      if (typeof value === "number") return value
    }
    return null
  }
  return (
    <ChartPanel
      icon={Cable}
      tone="conns"
      title="连接数"
      foot={
        <div role="group" aria-label="连接数曲线" className="flex flex-wrap gap-1.5">
          {CONNS.map((c) => {
            const shown = !hidden.includes(c.key)
            return (
              <Chip
                key={c.key}
                pressed={shown}
                aria-label={`${c.label}，${shown ? "已显示" : "已隐藏"}；按下${shown ? "隐藏" : "显示"}`}
                onClick={() => setHidden((h) => (shown ? [...h, c.key] : h.filter((k) => k !== c.key)))}
              >
                <Swatch stroke={c.stroke} dash={c.dash} />
                {c.label}
                <span className="tnum text-muted-foreground">{latest(c.key) ?? "—"}</span>
              </Chip>
            )
          })}
        </div>
      }
    >
      <ResponsiveContainer>
        <LineChart data={rows}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(rows, hours)} />
          {/* Zero included, unlike the latency axis: a socket count is read as a
              fraction of what the machine usually holds, and a line floating on
              its own minimum says nothing about that. */}
          <YAxis domain={[0, "auto"]} allowDecimals={false} {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} />
          {CONNS.filter((c) => !hidden.includes(c.key)).map((c) => (
            <Line
              key={c.key}
              dataKey={c.key}
              name={c.label}
              stroke={c.stroke}
              strokeDasharray={c.dash}
              {...RESOURCE_SERIES}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartPanel>
  )
}

/**
 * The resource panels over one window, and the connection panel when the hub
 * kept the counts.
 *
 * Memory and disk keep their totals as axis tops, because fullness is their
 * entire question; CPU and a transfer rate are fitted to what the window holds,
 * since against a fixed ceiling a machine idling at 0.4% draws a line along the
 * floor of its panel.
 *
 * Two columns from `lg`, with the network spanning both: a rate of transfer is
 * the figure read at a glance and its log axis wants the width, while the rest
 * pair up without either one growing a chart taller than the fold.
 */
export function Resources({ node, points, hours, budget, smooth, live }: {
  node: Node
  /** The hub's rows for the window, stamped in seconds. */
  points: Point[]
  hours: number
  /** The most samples the panels can draw: one per CSS pixel they occupy. */
  budget: number
  /** Whether single-bucket spikes in CPU are clipped to their neighbours. */
  smooth?: boolean
  /** The node's live sample, for the figures in the panel headings. */
  live?: Metrics | null
}) {
  // The hub answers in seconds; the time axis requires milliseconds. Each rate
  // also spans from its mean to its peak, which is the band drawn behind the
  // line; without a peak the band has no height. The rates drawn are lifted to
  // the floor of their log axis, which has no zero, while `net_rx` and `net_tx`
  // keep the hub's figures for the tooltip.
  const rows = useMemo<MetricRow[]>(() => {
    const lift = (v: number) => Math.max(v, RATE_FLOOR)
    return points.map((p) => ({
      ...p,
      ts: p.ts * 1_000,
      rx: lift(p.net_rx),
      tx: lift(p.net_tx),
      rx_band: [lift(p.net_rx), lift(p.net_rx_max ?? p.net_rx)],
      tx_band: [lift(p.net_tx), lift(p.net_tx_max ?? p.net_tx)],
    }))
  }, [points])
  // What the panels draw: the rows above, broken where the node was silent, and
  // thinned to what this screen can resolve. The axes are fitted to `rows`, not
  // to this: a sample the thinning drops must still open the axis wide enough
  // for the one it keeps, or the window's range would follow the budget.
  const chart = useMemo(() => {
    const broken = withGaps(rows)
    if (!budget || broken.length <= budget) return broken
    // All four panels share one row set, so every series votes on what is kept.
    // A hole has none of these fields, which is how the thinning finds it.
    const pick = (key: "cpu" | "rx" | "tx") => (row: MetricRow | { ts: number }) =>
      key in row ? (row as MetricRow)[key] : undefined
    return lttb(broken, budget, [pick("cpu"), pick("rx"), pick("tx")])
  }, [rows, budget])
  // CPU's line, with single-bucket spikes clipped to what its neighbours agree
  // on. The window is a duration, not a count, for the same reason as the
  // latency chart's: a day arrives as three-minute buckets on a desktop and
  // two-minute ones on a phone, and a fixed count would clip a real spike on
  // one and keep it on the other.
  //
  // A hole is null here rather than absent: `despike` skips nulls and would
  // otherwise read an undefined as a neighbour. The rows themselves are left
  // alone -- the other four panels draw from the same array.
  const plot = useMemo(() => {
    if (!smooth || chart.length === 0) return chart
    const values = chart.map((row) => ("cpu" in row ? (row as MetricRow).cpu : null))
    const cleaned = despike(values, despikeWindow(chart))
    return chart.map((row, i) => ({ ...row, cpu_s: cleaned[i] ?? undefined }))
  }, [chart, smooth])
  // The window's highest rate each way, or null from a hub that sends no peak.
  // Tested as a figure rather than as a field: a hub from before the peaks wrote
  // its column default of 0 into every old row, and `?? 0` would then label the
  // panel "峰值 ↓ 0 B/s" for a window that merely predates the column.
  const peak = useMemo(() => {
    if (!points.some((p) => (p.net_rx_max ?? 0) > 0 || (p.net_tx_max ?? 0) > 0)) return null
    const max = (pick: (p: Point) => number | undefined) => points.reduce((hi, p) => Math.max(hi, pick(p) ?? 0), 0)
    return { rx: max((p) => p.net_rx_max), tx: max((p) => p.net_tx_max) }
  }, [points])
  // Whether this hub kept the socket counts, which decides both the fifth card
  // and whether the rate has to share its row. A row of zeros is a default, not
  // a machine holding no sockets, so the test is on the figure.
  const withConns = points.some((p) => (p.tcp ?? 0) > 0 || (p.udp ?? 0) > 0)
  const axes = useMemo(() => {
    const max = (pick: (m: MetricRow) => number) => rows.reduce((hi, m) => Math.max(hi, pick(m)), 0)
    // A floor of 4%, or a machine that never exceeds 0.4% would get an axis of
    // 0-0.4 and render every scheduler blip as a peak. Capped at 100.
    const cpu = axisTop(max((m) => m.cpu), 4, 100)
    return {
      cpu: { domain: [0, cpu], ticks: quarters(cpu) },
      // From the slowest rate drawn to the highest peak, so the band stays
      // within the panel.
      rate: rateAxis(
        rows.reduce((lo, m) => Math.min(lo, m.rx, m.tx), Infinity),
        max((m) => Math.max(m.rx_band[1], m.tx_band[1])),
      ),
    }
  }, [rows])

  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      <ChartPanel
        icon={Cpu}
        tone="cpu"
        title={`CPU · ${node.cpu_cores} 核`}
        note={live ? (
          <span className="inline-flex items-baseline gap-1.5">
            <Figure text={pctText(live.cpu)} />
            <span className="text-2xs text-muted-foreground">负载 {live.load[0].toFixed(2)}</span>
          </span>
        ) : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={plot}>
            <ChartFade id="fade-cpu" color="var(--color-chart-1)" />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(plot, hours)} />
            <YAxis {...axes.cpu} unit="%" {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => [`${Number(v).toFixed(1)}%`, "CPU"]} />
            <Area
              dataKey={smooth ? "cpu_s" : "cpu"}
              stroke="var(--color-chart-1)"
              fill="url(#fade-cpu)"
              {...RESOURCE_SERIES}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* The axis top is the machine's memory, so the line's height is the
          fraction in use whatever range is picked. Tracking the window's own
          maximum, which is what an area chart does by default, puts 127 MB of a
          457 MB box at the top of the panel. The size is in the title because
          the axis top is claiming it. */}
      <ChartPanel
        icon={MemoryStick}
        tone="mem"
        title={`内存 · ${axisBytes(node.mem_total)}`}
        note={live ? <Figure text={pctText(percent(live.mem_used, live.mem_total))} /> : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={plot}>
            <ChartFade id="fade-mem" color="var(--color-chart-4)" />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(plot, hours)} />
            <YAxis domain={[0, node.mem_total]} ticks={quarters(node.mem_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
            <Area dataKey="mem_used" name="内存" stroke="var(--color-chart-4)" fill="url(#fade-mem)" {...RESOURCE_SERIES} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* The disk it is filling, for the same reason as memory: a node using
          2.7% of its disk draws along the top of the panel when the axis tracks
          the window's own maximum. */}
      <ChartPanel
        icon={HardDrive}
        tone="disk"
        title={`硬盘 · ${axisBytes(node.disk_total)}`}
        note={live ? <Figure text={pctText(percent(live.disk_used, live.disk_total))} /> : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={plot}>
            <ChartFade id="fade-disk" color="var(--color-chart-2)" />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(plot, hours)} />
            <YAxis domain={[0, node.disk_total]} ticks={quarters(node.disk_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
            <Area dataKey="disk_used" name="硬盘" stroke="var(--color-chart-2)" fill="url(#fade-disk)" {...RESOURCE_SERIES} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      {/* Drawn only for a hub that sent the counts: an empty panel would claim
          the machine holds no sockets. */}
      {withConns && <Connections rows={plot} hours={hours} live={live} />}

      {/* A rate has no total to be a fraction of, and its range spans orders of
          magnitude: a week of one node runs from 0.2 KB/s idle to bursts of
          70 MB/s. Fitted to the bursts, a linear axis would draw the median
          minute less than a pixel above the floor on seven of nine nodes at the
          day window, so this one is logarithmic, each tenfold step the same
          height.

          The line is the bucket's mean, so it integrates to the traffic totals,
          and a 15-second speed test averaged over its minute draws at a quarter
          of the rate it ran at. The band behind it reaches the highest rate
          measured within the bucket, and is edged because a one-minute burst on
          a day's axis is narrower than a pixel, where a fill alone does not
          show. The edge is dashed rather than faded: the rates are told apart by
          shade, and a faded edge of one would take the shade of the other's
          line. Its lower edge lies under the line.

          Full width when the sockets sit beside it, half otherwise: four panels
          pair up into two rows, five leave the rate the odd one out and the
          width its log axis wants. */}
      <ChartPanel
        icon={Network}
        tone="net"
        title="网络速率"
        subtitle={peak ? `峰值 ↓ ${rate(peak.rx)} · ↑ ${rate(peak.tx)}` : undefined}
        note={live ? (
          <span className="inline-flex items-baseline gap-1.5">
            <Glyph icon={ArrowDown} box="sm" />
            <Figure text={rate(live.net_rx)} size="xs" />
            <Glyph icon={ArrowUp} box="sm" />
            <Figure text={rate(live.net_tx)} size="xs" />
          </span>
        ) : undefined}
        className={withConns ? "lg:col-span-2" : undefined}
      >
        <ResponsiveContainer>
          <ComposedChart data={plot}>
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(plot, hours)} />
            {/* Wider than the other axes: "100 MB/s" is the longest tick in the
                page, and recharts wraps a label it thinks will not fit -- which
                put "100" on one line and "MB/s" on the next, half of it clipped
                by the plot's top edge. */}
            <YAxis scale="log" {...axes.rate} tickFormatter={axisBytes} unit="/s" {...VALUE_AXIS} width={80} />
            <Tooltip
              {...TOOLTIP}
              // The hub's figures rather than `v`, which is lifted to the axis
              // floor.
              formatter={(_, name, item) => {
                const mean = item?.payload?.[`net_${item.dataKey}`]
                const top = item?.payload?.[`net_${item.dataKey}_max`]
                return [top === undefined ? rate(mean) : `均值 ${rate(mean)} · 峰值 ${rate(top)}`, name]
              }}
            />
            {[
              // Two bands at one opacity merge into a third colour where they
              // overlap, and the overlap is exactly the busy stretch a reader is
              // looking at: the downward fill is the stronger of the two and the
              // upward one is a tint behind it, so a stack still reads as two.
              { key: "rx", stroke: "var(--color-ok)", fill: 0.18 },
              { key: "tx", stroke: "var(--color-chart-1)", fill: 0.09 },
            ].map((s) => (
              <Area
                key={s.key}
                dataKey={`${s.key}_band`}
                stroke={s.stroke}
                strokeWidth={1}
                strokeDasharray="2 2"
                fill={s.stroke}
                fillOpacity={s.fill}
                isAnimationActive={false}
                tooltipType="none"
                legendType="none"
              />
            ))}
            <Line dataKey="rx" name="下行" stroke="var(--color-ok)" {...RESOURCE_SERIES} />
            <Line dataKey="tx" name="上行" stroke="var(--color-chart-1)" {...RESOURCE_SERIES} />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartPanel>
    </div>
  )
}

/**
 * The page's composition: header, optional note, the sixteen live figures, the
 * four information cards, then the load and latency halves. Each half owns its
 * range and its request; this component only places them.
 */
export function NodeDetail({ node, historyDays, onBack, nodes = [], onOpen }: {
  node: Node
  historyDays: number
  onBack: () => void
  /** The public fleet, already ordered, for the header's switcher. */
  nodes?: Node[]
  onOpen?: (id: number) => void
}) {
  return (
    <div className="space-y-4">
      <DetailHeader node={node} nodes={nodes} onBack={onBack} onOpen={onOpen} />

      {/* The note the operator wrote for visitors. The hub has sent this on
          every frame since the monorepo merge and nothing rendered it, while
          the panel-only `remark` was drawn here instead: a visitor saw no note
          at all, and a signed-in one saw a note written for themselves. The
          public one wins; `remark` is the fallback for a hub that predates it. */}
      {(node.public_remark || node.remark) && (
        <p className="rounded-lg bg-card-2 px-3 py-2 text-sm whitespace-pre-wrap">{node.public_remark || node.remark}</p>
      )}

      <MetricGrid node={node} />
      <InfoGrid node={node} />
      <LoadSection node={node} historyDays={historyDays} />
      <LatencySection node={node} historyDays={historyDays} />
    </div>
  )
}
