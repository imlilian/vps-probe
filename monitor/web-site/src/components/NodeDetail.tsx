import { useEffect, useMemo, useState } from "react"
import { ArrowDown, ArrowLeft, ArrowUp } from "lucide-react"
import {
  Area, AreaChart, Brush, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, type DotItemDotProps,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Chip, Segmented } from "@/components/ui/chip"
import { Glyph } from "@/components/ui/glyph"
import { Skeleton } from "@/components/ui/skeleton"
import { percentText } from "@/components/Meter"
import { Country, Status } from "@/components/NodeCard"
import { api, type Metrics, type Node } from "@/lib/api"
import {
  axisBytes, axisTop, bytes, clockFor, cpuName, cycle, despike, FOREVER, money, osName,
  percent, quarters, rate, RATE_FLOOR, rateAxis, tickClock, timeTicks, windows, withGaps,
} from "@/lib/format"
import { cn } from "@/lib/utils"

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
// `latency` is the bucket's median round trip, null when every probe in it timed
// out. `band` is the range its answers spanned, absent when they spanned nothing.
// `loss` is the percentage that timed out, absent when none did.
type PingPoint = {
  task_id: number
  ts: number
  latency: number | null
  band?: [number, number]
  loss?: number
}
/** Probe names by id, sent alongside the samples they label. */
type Probes = Record<string, string>
/**
 * Proportion of the whole window each probe lost, by id, absent for probes that
 * lost nothing. Sent because it cannot be derived here: every bucket's `loss` is
 * already a percentage of that bucket, so the sample counts it was divided by are
 * unavailable. Averaging them would weight a bucket holding one sample equally
 * with one holding twelve, and the window's first and last buckets are partial
 * regardless of what the probe does.
 */
type Loss = Record<string, number>

const AXIS = { stroke: "currentColor", fontSize: 11, tickLine: false, axisLine: false }

// No grow-in animation: it would spend 1.5 s drawing a line across the panel on
// every range change, on a page meant to be read at a glance, and on the latency
// chart across seven hundred points per probe.
const SERIES = { dot: false as const, strokeWidth: 1.5, isAnimationActive: false }

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

// The palette is greyscale, so lightness alone is exhausted after two or three
// series and the dash pattern carries the rest.
// ponytail: the dash period is shorter than the jitter once every ping in the
// window is on the chart, so at the day range a dotted line and a dashed one both
// read as texture and only lightness separates them. A muted colour palette was
// built and measured but not adopted; restoring it means five oklch pairs and
// dropping `dash`.
const PALETTE = [
  { stroke: "var(--color-chart-1)", dash: undefined },
  { stroke: "var(--color-chart-3)", dash: "6 3" },
  { stroke: "var(--color-chart-2)", dash: "2 3" },
  { stroke: "var(--color-chart-4)", dash: "10 4 2 4" },
  { stroke: "var(--color-chart-5)", dash: "1 4" },
]

const TABS = [
  { value: "resources", label: "资源" },
  { value: "latency", label: "网络延迟" },
] as const
type Tab = (typeof TABS)[number]["value"]

// Sockets in one hue each and processes in a dash: a process count is not a
// socket, and on the same axis it would otherwise read as a third kind of
// connection. The hues are the chart palette's first three steps, so a spike in
// one of these panels is the same blue as a spike in CPU's.
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

/**
 * One chart in its card: a heading, the figure the chart is currently at, and
 * the plot. The value on the right is live -- the node prop behind it updates
 * every two seconds -- so the card answers "and now?" without a trip to the
 * last point of the line.
 *
 * `foot` is for what does not fit the heading, such as the connection legend,
 * which is also its readout.
 *
 * min-w-0 on the card is load-bearing: a grid item refuses to shrink below its
 * content, recharts writes the measured width onto the <svg> as an attribute,
 * and that number then becomes the card's floor. On a phone the chart held the
 * card 47px wider than the column and the page scrolled sideways. `min-w-0` lets
 * the track win, and the container measures again.
 */
function Panel({ title, note, foot, className, children }: {
  title: string
  note?: React.ReactNode
  foot?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={cn("min-w-0 gap-0 p-4", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-xs font-medium text-muted-foreground" title={title}>{title}</h3>
        {note != null && <span className="tnum shrink-0 text-xs font-medium">{note}</span>}
      </div>
      <div className="mt-2 h-40 w-full text-muted-foreground">{children}</div>
      {foot != null && <div className="mt-3">{foot}</div>}
    </Card>
  )
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
    <Panel
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
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
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
    </Panel>
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
export function Resources({ node, points, hours, live }: {
  node: Node
  /** The hub's rows for the window, stamped in seconds. */
  points: Point[]
  hours: number
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
  // What the panels draw: the rows above, broken where the node was silent. The
  // axes are fitted to the rows alone.
  const chart = useMemo(() => withGaps(rows), [rows])
  // The window's highest rate each way, or null from a hub that sends no peak:
  // a maximum of the means would be labelled a peak it is not.
  const peak = useMemo(() => {
    if (!points.some((p) => p.net_rx_max !== undefined)) return null
    const max = (pick: (p: Point) => number | undefined) => points.reduce((hi, p) => Math.max(hi, pick(p) ?? 0), 0)
    return { rx: max((p) => p.net_rx_max), tx: max((p) => p.net_tx_max) }
  }, [points])
  // Whether this hub kept the socket counts, which decides both the fifth card
  // and whether the rate has to share its row.
  const withConns = points.some((p) => typeof p.tcp === "number")
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
      <Panel
        title={`CPU · ${node.cpu_cores} 核`}
        note={live ? `${percentText(live.cpu)} · 负载 ${live.load[0].toFixed(2)}` : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis {...timeAxis(chart, hours)} />
            <YAxis {...axes.cpu} unit="%" {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => [`${Number(v).toFixed(1)}%`, "CPU"]} />
            <Area dataKey="cpu" stroke="var(--color-chart-1)" fill="var(--color-chart-1)" fillOpacity={0.15} {...RESOURCE_SERIES} />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      {/* The axis top is the machine's memory, so the line's height is the
          fraction in use whatever range is picked. Tracking the window's own
          maximum, which is what an area chart does by default, puts 127 MB of a
          457 MB box at the top of the panel. The size is in the title because
          the axis top is claiming it. */}
      <Panel
        title={`内存 · ${bytes(node.mem_total)}`}
        note={live ? percentText(percent(live.mem_used, live.mem_total)) : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis {...timeAxis(chart, hours)} />
            <YAxis domain={[0, node.mem_total]} ticks={quarters(node.mem_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
            <Area dataKey="mem_used" name="内存" stroke="var(--color-chart-2)" fill="var(--color-chart-2)" fillOpacity={0.15} {...RESOURCE_SERIES} />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      {/* The disk it is filling, for the same reason as memory: a node using
          2.7% of its disk draws along the top of the panel when the axis tracks
          the window's own maximum. */}
      <Panel
        title={`硬盘 · ${bytes(node.disk_total)}`}
        note={live ? percentText(percent(live.disk_used, live.disk_total)) : undefined}
      >
        <ResponsiveContainer>
          <AreaChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis {...timeAxis(chart, hours)} />
            <YAxis domain={[0, node.disk_total]} ticks={quarters(node.disk_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(v) => bytes(Number(v))} />
            <Area dataKey="disk_used" name="硬盘" stroke="var(--color-chart-2)" fill="var(--color-chart-2)" fillOpacity={0.15} {...RESOURCE_SERIES} />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      {/* Drawn only for a hub that sent the counts: an empty panel would claim
          the machine holds no sockets. */}
      {withConns && <Connections rows={chart} hours={hours} live={live} />}

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
      <Panel
        title={peak ? `网络速率 · 峰值 ↓ ${rate(peak.rx)} · ↑ ${rate(peak.tx)}` : "网络速率"}
        note={live ? (
          <span className="inline-flex items-baseline gap-1.5">
            <Glyph icon={ArrowDown} box="sm" />
            {rate(live.net_rx)}
            <Glyph icon={ArrowUp} box="sm" />
            {rate(live.net_tx)}
          </span>
        ) : undefined}
        className={withConns ? "lg:col-span-2" : undefined}
      >
        <ResponsiveContainer>
          <ComposedChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis {...timeAxis(chart, hours)} />
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
              { key: "rx", stroke: "var(--color-ok)" },
              { key: "tx", stroke: "var(--color-chart-1)" },
            ].map((s) => (
              <Area
                key={s.key}
                dataKey={`${s.key}_band`}
                stroke={s.stroke}
                strokeWidth={1}
                strokeDasharray="2 2"
                fill={s.stroke}
                fillOpacity={0.16}
                isAnimationActive={false}
                tooltipType="none"
                legendType="none"
              />
            ))}
            <Line dataKey="rx" name="下行" stroke="var(--color-ok)" {...RESOURCE_SERIES} />
            <Line dataKey="tx" name="上行" stroke="var(--color-chart-1)" {...RESOURCE_SERIES} />
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  )
}

/**
 * A figure and its unit are one token. Left to break freely, a cell on a phone
 * ended a line at "↑ 4.53" and put "GB" alone on the next; a non-breaking space
 * between a number and the letters that follow it keeps the pair together and
 * moves the break to the separator, where it belongs.
 */
const glued = (text: string) => text.replace(/(\d) (?=[A-Za-z%])/g, "$1\u00a0")

/**
 * One cell of the spec sheet. The label is a step down and muted, the figure is
 * the thing read, and a value too long for a phone's 124px of cell wraps to a
 * second line: `¥59.90 / 月付 · 2026-09-28 到期` is one fact, and truncating it
 * would hide the date someone came for. The whole value stays in the tooltip for
 * whatever still does not fit.
 */
function Fact({ label, value }: { label: string; value?: string | number | null }) {
  if (value === null || value === undefined || value === "") return null
  return (
    <div className="min-w-0 bg-card px-3 py-2.5">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 line-clamp-2 text-sm leading-snug font-medium" title={String(value)}>
        {typeof value === "string" ? glued(value) : value}
      </dd>
    </div>
  )
}

/**
 * `historyDays` is how far back the hub keeps history. Both tabs offer every
 * window within it: up to a day each ping is on the latency chart, and past it a
 * point is a bucket -- its median, the range its answers spanned and the share
 * lost -- which over a month shows a route's evening pattern a day cannot.
 */
export function NodeDetail({ node, historyDays, onBack }: {
  node: Node
  historyDays: number
  onBack: () => void
}) {
  const ranges = useMemo(() => windows(historyDays), [historyDays])
  const [tab, setTab] = useState<Tab>("resources")
  // Each tab keeps its own range: a 7-day trend and a 1-hour trace answer
  // different questions.
  const [picked, setPicked] = useState({ resources: 6, latency: 6 })
  const hours = picked[tab]
  const [smooth, setSmooth] = useState(false)
  // Probes switched off. Hiding a slow one is what makes the fast ones readable,
  // as the axis rescales to what remains.
  const [hiddenProbes, setHiddenProbes] = useState<number[]>([])
  const [data, setData] = useState<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss } | null>(null)
  // Retained rather than folded into an empty result: a refused request and an
  // empty window are different answers, and the hub has reason to refuse this one
  // -- it caps how many history windows it builds concurrently. Rendered as an
  // empty window, a 503 would misdirect the reader.
  const [failed, setFailed] = useState("")
  const [attempt, setAttempt] = useState(0)
  // Where the brush has been dragged, so the axis reticks for the visible span
  // rather than retaining the whole window's ticks.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  // Where the chart begins on screen, so its height can occupy the remainder.
  const [chartTop, setChartTop] = useState(0)

  useEffect(() => {
    let active = true
    // The charts must not continue drawing the old range while the new one is in
    // flight.
    // oxlint-disable-next-line react/set-state-in-effect
    setData(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setZoom(null)
    // oxlint-disable-next-line react/set-state-in-effect
    setFailed("")
    // What this screen can resolve, in device pixels, which is the unit the line
    // is drawn in: a 1280-wide retina panel has 2560 of them for a day of minutes.
    // Read here rather than from a ref, since the hub only thins further, an
    // approximate figure suffices, and the viewport is known before layout. A
    // rotation keeps whatever it fetched with.
    //
    // The tab determines which half is requested; the other accounted for a third
    // to two thirds of every response and was never drawn.
    const points = Math.round(globalThis.innerWidth * (globalThis.devicePixelRatio || 1))
    const series = tab === "latency" ? "ping" : "metrics"
    api<{ metrics: Point[]; ping: PingPoint[]; probes: Probes; loss?: Loss }>(
      `/nodes/${node.id}/metrics?hours=${hours}&points=${points}&series=${series}`,
    )
      .then((next) => { if (active) setData(next) })
      .catch((e: Error) => {
        if (active) { setFailed(e.message); setData({ metrics: [], ping: [], probes: {} }) }
      })
    return () => { active = false }
  }, [node.id, hours, tab, attempt])

  const m = node.metrics
  // One series per probe that reported, labelled from the names the samples
  // arrived with. Memoised, as is the chart's row set below: the node prop
  // changes every few seconds as live metrics arrive, and rebuilding the chart's
  // data array on those renders would reset the brush.
  const pingSeries = useMemo(
    () =>
      [...new Set((data?.ping ?? []).map((p) => p.task_id))]
        .map((id) => {
          // Timeouts are retained: dropping them would draw a probe losing half
          // its packets as an unbroken line, and one that never answered not at
          // all.
          const points = (data?.ping ?? []).filter((p) => p.task_id === id)
          // Taken from the hub rather than summed from the buckets above, each of
          // which is already a percentage of its own bucket, so averaging them
          // would report one lost round in thirteen as 50%. Left unrounded, since
          // `Math.round` would render 0.28% and 0.00% as the same badge, and the
          // absence of a badge denotes no loss.
          const loss = data?.loss?.[id] ?? 0
          return { id, name: data?.probes?.[id] ?? `探测 ${id}`, points, loss }
        })
        .filter((s) => s.points.length > 0),
    [data],
  )

  const shownProbes = useMemo(
    () => pingSeries.filter((s) => !hiddenProbes.includes(s.id)),
    [pingSeries, hiddenProbes],
  )
  // Keyed on the full list, so a line keeps its shade when others are hidden.
  const style = (id: number) => PALETTE[pingSeries.findIndex((p) => p.id === id) % PALETTE.length]

  // The hub stamps every sample with its bucket rather than the second the probe
  // finished, so probes reporting at the bucket's rate share rows instead of each
  // contributing its own: a day of four probes is 717 rows rather than 2,868. A
  // slower probe leaves gaps in its own column, which is what `connectNulls`
  // addresses.
  //
  // Every probe and both versions of every sample are held here whether or not
  // they are on screen: recharts resets the brush when the data array changes
  // identity, and re-reads a controlled selection only when the index props
  // change, which they do not. Hiding a probe or enabling despiking therefore
  // selects a `dataKey` rather than rebuilding the array.
  const pingRows = useMemo(() => {
    const rows = new Map<
      number,
      { ts: number } & Record<string, number | [number, number] | null>
    >()
    for (const s of pingSeries) {
      const windowSize = despikeWindow(s.points)
      const smoothed = despike(s.points.map((p) => p.latency), windowSize)
      // The band spans the same outliers as the line, and with one probe on
      // screen it is what the axis is fitted to, so it is clipped alongside it
      // rather than left to pull the axis back open. The latency fills the
      // buckets that carry no band, keeping each filter's window dense.
      const lo = despike(s.points.map((p) => p.band?.[0] ?? p.latency), windowSize)
      const hi = despike(s.points.map((p) => p.band?.[1] ?? p.latency), windowSize)
      s.points.forEach((p, i) => {
        const row = rows.get(p.ts) ?? { ts: p.ts * 1_000 }
        row[`t${s.id}`] = p.latency
        row[`s${s.id}`] = smoothed[i]
        row[`l${s.id}`] = p.loss ?? 0
        // A bucket with a single answer carries no band and spans only that
        // answer. Left null, `connectNulls` would bridge the hours between the
        // few buckets that have one: 2 to 10 of 1,440 in a day, the widest gap
        // 803 minutes, drawn as one large wedge.
        row[`b${s.id}`] = p.band ?? (p.latency === null ? null : [p.latency, p.latency])
        // Taken as the span of three filtered series rather than a pair: the two
        // edges are filtered independently, so a bucket that answered slightly
        // faster than usual can trip the low edge alone and come back above the
        // high one -- [180, 178] against a line of 176, drawn backwards with the
        // line outside it.
        const [low, high] = [lo[i], hi[i]]
        row[`c${s.id}`] =
          low === null || high === null
            ? null
            : [Math.min(low, high, smoothed[i] ?? low), Math.max(low, high, smoothed[i] ?? high)]
        rows.set(p.ts, row)
      })
    }
    return [...rows.values()].sort((a, b) => a.ts - b.ts)
  }, [pingSeries])

  // The spec sheet: one machine's facts, in one strip. Six cells, so the grid
  // divides cleanly into rows of two, three and six.
  const facts = [
    { label: "系统", value: [osName(node.os), node.kernel].filter(Boolean).join(" · ") },
    { label: "CPU", value: node.cpu_name ? `${cpuName(node.cpu_name)} × ${node.cpu_cores}` : `${node.cpu_cores} 核` },
    { label: "内存 / 硬盘", value: `${bytes(node.mem_total)} / ${bytes(node.disk_total)}` },
    {
      label: "架构",
      value: [node.arch, node.virt !== "none" ? node.virt : "", m ? `${m.procs} 进程` : ""].filter(Boolean).join(" · "),
    },
    { label: "今日流量", value: `↓ ${bytes(node.day_rx)} · ↑ ${bytes(node.day_tx)}` },
    {
      label: "续费",
      value: [
        node.price > 0 ? `${money(node.price, node.currency)} / ${cycle(node.billing_cycle)}` : "免费",
        // The date alone: the hub stamps the expiry with a time of day, which is
        // a fact about the hub's clock and not about the renewal.
        node.expires_at ? `${node.expires_at.slice(0, 10)} 到期` : FOREVER,
      ].join(" · "),
    },
  ]

  return (
    <div className="space-y-4">
      {/* The list is one press away, and the way back has been the site name in
          the bar until now -- not where anyone looks for it once they are two
          machines deep. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
      >
        <Glyph icon={ArrowLeft} box="sm" />
        全部节点
      </Button>

      <Card className="min-w-0 gap-0 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <Country node={node} />
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight" title={node.name}>{node.name}</h2>
          <Status node={node} />
          {node.agent_version && (
            <Badge className="font-normal text-muted-foreground">agent {node.agent_version}</Badge>
          )}
        </div>

        {/* Hairline cells rather than a grid of whitespace: a spec sheet reads as
            a table, and the lines are what let a phone wrap it to two columns
            without the pairs drifting apart. */}
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 xl:grid-cols-6">
          {facts.map((fact) => <Fact key={fact.label} {...fact} />)}
        </dl>

        {node.remark && (
          <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{node.remark}</p>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <Segmented label="视图" value={tab} items={TABS} onChange={setTab} />
        {/* Wraps on a screen narrower than the seven windows of a year. */}
        <div role="group" aria-label="时间范围" className="flex flex-wrap gap-1">
          {ranges.map((r) => (
            <Chip
              key={r.hours}
              pressed={hours === r.hours}
              onClick={() => setPicked((all) => ({ ...all, [tab]: r.hours }))}
            >
              {r.label}
            </Chip>
          ))}
        </div>
        {tab === "latency" && (
          <Chip
            pressed={smooth}
            onClick={() => setSmooth((on) => !on)}
            title="按邻点中位数削去单点尖峰"
          >
            削峰
          </Chip>
        )}
      </div>

      {!data ? (
        <Card className="min-w-0 gap-0 p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-40 w-full" />
        </Card>
      ) : failed ? (
        <p className="py-8 text-center text-sm text-destructive" role="alert">
          读取历史数据失败：{failed}
          <button
            className="ml-2 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => setAttempt((n) => n + 1)}
          >重试</button>
        </p>
      ) : tab === "latency" ? (
        pingSeries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有延迟数据</p>
        ) : (
          <Card className="min-w-0 gap-0 p-4">
            {/* An explicit pixel height on the column, so the chart can be
                `flex-1` within it while the legend takes what it needs: four
                probes are one row of chips on a desktop and two on a phone, so
                any fixed reservation is wrong on one of them. */}
            <div
              // `+ scrollY`, because getBoundingClientRect is measured from the
              // viewport and this callback runs on every render; a live node
              // re-renders every two seconds, so a scrolled page would re-derive
              // the height from a top that has moved.
              ref={(el) => {
                if (el) setChartTop(el.getBoundingClientRect().top + scrollY)
              }}
              style={
                chartTop
                  ? { height: `calc(100svh - ${Math.round(chartTop)}px - 1rem)` }
                  : undefined
              }
              className="flex min-h-72 flex-col gap-3">
              {/* `min-h-0` is what makes `flex-1` a real number rather than the
                  content's own height: ResponsiveContainer reads its parent, and
                  a flex child not told it may shrink reports whatever the SVG
                  last was. The column above has a height in pixels, so this
                  resolves at layout instead of coming back 0. */}
              <div className="min-h-0 w-full flex-1 text-muted-foreground">
                {shownProbes.length === 0 ? (
                  <p className="py-8 text-center text-sm">没有选中任何探测</p>
                ) : (
                  <ResponsiveContainer>
                    <ComposedChart data={pingRows}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                      <XAxis
                        {...timeAxis(
                          pingRows,
                          hours,
                          Math.min(zoom?.[0] ?? 0, pingRows.length - 1),
                          Math.min(zoom?.[1] ?? pingRows.length - 1, pingRows.length - 1),
                        )}
                      />
                      {/* Not anchored at zero: these lines live in a narrow band
                          far from it, and zero flattens every wobble. */}
                      <YAxis unit="ms" width={52} domain={["auto", "auto"]} {...AXIS} />
                      <Tooltip
                        {...TOOLTIP}
                        // The line is drawn from what answered, so without this a
                        // bucket that lost most of its packets reads as normal.
                        // `dataKey` is `t7`/`s7`; the loss sits at `l7`.
                        //
                        // Rounded because a clipped sample carries the median of
                        // an even window, which falls between two of the whole
                        // milliseconds the hub stores.
                        formatter={(v, name, item) => {
                          const loss = Number(item?.payload?.[`l${String(item.dataKey).slice(1)}`] ?? 0)
                          return [`${Math.round(Number(v))} ms${loss > 0 ? ` · 丢 ${loss}%` : ""}`, name]
                        }}
                      />
                      {/* Behind the line, the range that bucket's answers
                          spanned -- Smokeping's "smoke". At the day window a
                          bucket moves 63 ms at the 90th percentile against the
                          25 ms the trend moves, so a line alone draws the smaller
                          of the two.

                          Only with one probe on screen: rendered for four, the
                          bands overlap into a fog and their extremes drag the
                          axis from 165-385 out to 140-420. */}
                      {shownProbes.length === 1 &&
                        shownProbes.map((s) => (
                          <Area
                            key={`band${s.id}`}
                            dataKey={`${smooth ? "c" : "b"}${s.id}`}
                            stroke="none"
                            fill={style(s.id).stroke}
                            fillOpacity={0.16}
                            isAnimationActive={false}
                            tooltipType="none"
                            legendType="none"
                            connectNulls
                          />
                        ))}
                      {shownProbes.map((s) => (
                        <Line
                          key={s.id}
                          dataKey={`${smooth ? "s" : "t"}${s.id}`}
                          name={s.name}
                          stroke={style(s.id).stroke}
                          strokeDasharray={style(s.id).dash}
                          {...SERIES}
                          connectNulls
                        />
                      ))}
                      {/* Drag either handle to zoom into a stretch of the trend. */}
                      <Brush
                        dataKey="ts"
                        height={22}
                        travellerWidth={8}
                        tickFormatter={clockFor(hours)}
                        className="fill-muted"
                        stroke="var(--color-muted-foreground)"
                        onChange={(r) => setZoom([r.startIndex ?? 0, r.endIndex ?? pingRows.length - 1])}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>

              {/* Under the chart: what it covers is picked at the top, what is
                  drawn in it is picked here. Recharts paints the brush into the
                  same SVG as the axis, so this is as close beneath as HTML
                  sits. */}
              {(pingSeries.length > 1 || pingSeries.some((s) => s.loss > 0)) && (
                <div role="group" aria-label="探测" className="flex flex-wrap items-center justify-center gap-1.5">
                  {pingSeries.map((s) => {
                    const shown = !hiddenProbes.includes(s.id)
                    return (
                      <Chip
                        key={s.id}
                        pressed={shown}
                        aria-label={`${s.name}，${shown ? "已显示" : "已隐藏"}；按下${shown ? "隐藏" : "显示"}`}
                        className={cn(!shown && "opacity-50")}
                        onClick={() =>
                          setHiddenProbes((h) => (shown ? [...h, s.id] : h.filter((id) => id !== s.id)))
                        }
                      >
                        <Swatch stroke={style(s.id).stroke} dash={style(s.id).dash} />
                        {s.name}
                        {/* The line is only what answered, so a probe dropping
                            half its packets draws like a healthy one. */}
                        {s.loss > 0 && (
                          <span className="tnum text-muted-foreground">
                            丢 {s.loss < 1 ? "<1" : Math.round(s.loss)}%
                          </span>
                        )}
                      </Chip>
                    )
                  })}
                </div>
              )}
            </div>
          </Card>
        )
      ) : data.metrics.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有历史数据</p>
      ) : (
        <Resources node={node} points={data.metrics} hours={hours} live={m} />
      )}
    </div>
  )
}
