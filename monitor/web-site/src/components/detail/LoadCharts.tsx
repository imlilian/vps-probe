import { useId, useMemo, useRef, useState } from "react"
import { Activity, Cable, Cpu, HardDrive, MemoryStick, Network } from "lucide-react"
import {
  Area, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

import { ChartFade } from "./ChartFade"
import type { Node } from "@/lib/api"
import {
  COLOR, CPU_TICKS, DERIVED, GRID, hideZero, LINE, MARGIN, PEAK, tickCount, TOOLTIP, VALUE_AXIS, timeAxis,
} from "@/lib/chart"
import { detailBytes, detailRate, diskForecast } from "@/lib/detail"
import { decimate } from "@/lib/downsample"
import { axisBytes, countAxis, despike, despikeWindow, quarters, RATE_FLOOR, rateAxis, withGaps } from "@/lib/format"
import { useElementWidth, type MetricPoint } from "@/lib/history"
import { renderBudget } from "@/lib/sampling"

import { ChartCard } from "./ChartCard"
import { ChartLegend, type LegendItem } from "./ChartLegend"

type ChartRow = MetricPoint & {
  cpu_s?: number | null
  mem_total?: number
  swap_total?: number
  disk_total?: number
}

/** A figure and its unit, the unit a step down; the card heads use this shape. */
function Num({ value, unit }: { value: string; unit?: string }) {
  return (
    <span className="tnum">
      <span className="font-semibold text-foreground">{value}</span>
      {unit && <span className="ml-1 text-2xs font-normal">{unit}</span>}
    </span>
  )
}

/** Every series of a panel switched off: a sentence rather than a pair of empty axes. */
const NO_SERIES = "没有选中任何序列"

/** The lowest and highest of the readings a panel is actually drawing. */
function extent(values: (number | null | undefined)[]): [number, number] {
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (typeof value !== "number") continue
    if (value < low) low = value
    if (value > high) high = value
  }
  return [low, high]
}

function useHidden() {
  const [hidden, setHidden] = useState<string[]>([])
  return {
    hidden,
    toggle: (key: string) => setHidden((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key])),
  }
}

function CpuPanel({ node, rows, hours, smooth, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; smooth: boolean; budget: number; ticks: number }) {
  const { hidden, toggle } = useHidden()
  const fade = useId().replace(/:/g, "")
  const hasPeak = rows.some((r) => (r.cpu_max ?? 0) > 0)
  const data = useMemo(() => decimate(rows, budget, [
    (row) => row.cpu,
    ...(hasPeak ? [(row: ChartRow) => row.cpu_max] : []),
  ]), [rows, budget, hasPeak])
  const chart = useMemo(() => {
    if (!smooth) return data
    const cleaned = despike(data.map((r) => ("cpu" in r ? r.cpu : null)), despikeWindow(data))
    return data.map((r, i) => ({ ...r, cpu_s: cleaned[i] }))
  }, [data, smooth])
  const live = node.metrics
  const items: LegendItem[] = [
    { key: "cpu", label: "CPU", color: COLOR.cpu },
    ...(hasPeak ? [{ key: "peak", label: "峰值", color: COLOR.cpu, dash: "6 3" }] : []),
  ]
  const empty = hidden.includes("cpu") && (!hasPeak || hidden.includes("peak"))

  return (
    <ChartCard
      icon={Cpu}
      tone="cpu"
      title="CPU"
      note={live ? <Num value={live.cpu.toFixed(1)} unit="%" /> : <span>—</span>}
      legend={<ChartLegend label="CPU 曲线" items={items} hidden={hidden} onToggle={toggle} />}
      empty={empty ? NO_SERIES : undefined}
    >
      {!empty && (
        <ResponsiveContainer>
          <ComposedChart data={chart} margin={MARGIN}>
            <ChartFade id={fade} color={COLOR.cpu} />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(chart, hours, ticks)} />
            <YAxis domain={[0, 100]} ticks={CPU_TICKS} tickFormatter={hideZero((v) => `${v}%`)} {...VALUE_AXIS} />
            <Tooltip {...TOOLTIP} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]} />
            {!hidden.includes("cpu") && (
              <Area dataKey={smooth ? "cpu_s" : "cpu"} name="CPU" stroke={COLOR.cpu} fill={`url(#${fade})`} {...LINE} />
            )}
            {hasPeak && !hidden.includes("peak") && (
              <Line dataKey="cpu_max" name="峰值" stroke={COLOR.cpu} {...PEAK} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function MemoryPanel({ node, rows, hours, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; budget: number; ticks: number }) {
  const { hidden, toggle } = useHidden()
  const fade = useId().replace(/:/g, "")
  const hasSwap = node.swap_total > 0 && rows.some((r) => "swap_used" in r)
  /**
   * The axis has to hold the tallest reference line on the plot, and that is not
   * always RAM: a swap file of twice the RAM is a common recipe on a 2 GB box,
   * and with the ceiling pinned to `mem_total` its `Swap 总量` line was drawn
   * above the top of the plot -- clipped away, so the card said "memory and
   * swap" while showing no swap ceiling at all.
   */
  const ceiling = hasSwap ? Math.max(node.mem_total, node.swap_total) : node.mem_total
  const data = useMemo(() => decimate(rows, budget, [
    (row) => row.mem_used,
    ...(hasSwap ? [(row: ChartRow) => row.swap_used] : []),
  ]), [rows, budget, hasSwap])
  const live = node.metrics
  const items: LegendItem[] = [
    { key: "mem", label: "RAM", color: COLOR.mem },
    { key: "memTotal", label: "RAM 总量", color: COLOR.memTotal, dash: "6 3" },
    ...(hasSwap
      ? [
          { key: "swap", label: "Swap", color: COLOR.swap },
          { key: "swapTotal", label: "Swap 总量", color: COLOR.swapTotal, dash: "6 3" },
        ]
      : []),
  ]

  return (
    <ChartCard
      icon={MemoryStick}
      tone="mem"
      title={hasSwap ? "内存与 Swap" : "内存"}
      note={live ? (
        <span className="tnum">
          {detailBytes(live.mem_used)} <span className="text-muted-foreground">·</span> {detailBytes(node.mem_total)}
        </span>
      ) : <span>—</span>}
      legend={<ChartLegend label="内存曲线" items={items} hidden={hidden} onToggle={toggle} />}
      empty={items.every((item) => hidden.includes(item.key)) ? NO_SERIES : undefined}
    >
      {items.some((item) => !hidden.includes(item.key)) && (
        <ResponsiveContainer>
          <ComposedChart data={data} margin={MARGIN}>
            <ChartFade id={fade} color={COLOR.mem} />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(data, hours, ticks)} />
            <YAxis
              domain={[0, ceiling]}
              ticks={quarters(ceiling)}
              tickFormatter={hideZero(axisBytes)}
              {...VALUE_AXIS}
            />
            <Tooltip {...TOOLTIP} formatter={(value) => detailBytes(Number(value))} />
            {!hidden.includes("memTotal") && (
              <Line dataKey="mem_total" name="RAM 总量" stroke={COLOR.memTotal} {...DERIVED} />
            )}
            {hasSwap && !hidden.includes("swapTotal") && (
              <Line dataKey="swap_total" name="Swap 总量" stroke={COLOR.swapTotal} {...DERIVED} />
            )}
            {!hidden.includes("mem") && (
              <Area dataKey="mem_used" name="RAM" stroke={COLOR.mem} fill={`url(#${fade})`} {...LINE} />
            )}
            {hasSwap && !hidden.includes("swap") && (
              <Line dataKey="swap_used" name="Swap" stroke={COLOR.swap} {...LINE} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function DiskPanel({ node, rows, hours, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; budget: number; ticks: number }) {
  const { hidden, toggle } = useHidden()
  const fade = useId().replace(/:/g, "")
  const data = useMemo(() => decimate(rows, budget, [(row) => row.disk_used]), [rows, budget])
  const live = node.metrics
  const items: LegendItem[] = [
    { key: "disk", label: "磁盘已用", color: COLOR.disk },
    { key: "diskTotal", label: "磁盘总量", color: COLOR.diskTotal, dash: "6 3" },
  ]

  return (
    <ChartCard
      icon={HardDrive}
      tone="disk"
      title="磁盘"
      subtitle={diskForecast(rows, node.disk_total) ?? undefined}
      note={live ? (
        <span className="tnum">
          {detailBytes(live.disk_used)} <span className="text-muted-foreground">·</span> {detailBytes(node.disk_total)}
        </span>
      ) : <span>—</span>}
      legend={<ChartLegend label="磁盘曲线" items={items} hidden={hidden} onToggle={toggle} />}
      empty={items.every((item) => hidden.includes(item.key)) ? NO_SERIES : undefined}
    >
      {items.some((item) => !hidden.includes(item.key)) && (
        <ResponsiveContainer>
          <ComposedChart data={data} margin={MARGIN}>
            <ChartFade id={fade} color={COLOR.disk} />
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(data, hours, ticks)} />
            <YAxis
              domain={[0, node.disk_total]}
              ticks={quarters(node.disk_total)}
              tickFormatter={hideZero(axisBytes)}
              {...VALUE_AXIS}
            />
            <Tooltip {...TOOLTIP} formatter={(value) => detailBytes(Number(value))} />
            {!hidden.includes("diskTotal") && (
              <Line dataKey="disk_total" name="磁盘总量" stroke={COLOR.diskTotal} {...DERIVED} />
            )}
            {!hidden.includes("disk") && (
              <Area dataKey="disk_used" name="磁盘已用" stroke={COLOR.disk} fill={`url(#${fade})`} {...LINE} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function NetworkPanel({ node, rows, hours, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; budget: number; ticks: number }) {
  const { hidden, toggle } = useHidden()
  const hasPeak = rows.some((r) => (r.net_rx_max ?? 0) > 0 || (r.net_tx_max ?? 0) > 0)
  const data = useMemo(() => decimate(rows, budget, [
    (row) => row.net_rx,
    (row) => row.net_tx,
    ...(hasPeak ? [(row: ChartRow) => row.net_rx_max, (row: ChartRow) => row.net_tx_max] : []),
  ]), [rows, budget, hasPeak])
  const live = node.metrics
  /**
   * The axis runs from the slowest rate on screen to the fastest, not from the
   * floor: `rateAxis` was being handed `RATE_FLOOR` as its low end, so a link
   * drawing 2 to 13 MB/s printed 1 KB/s, 10 KB/s and 100 KB/s under the line --
   * five sixths of the plot empty, and the top label a decade above the data.
   *
   * Which series are on screen decides the ends, because switching one off is
   * what moves the axis: with the peaks hidden the axis is the two lines.
   */
  const drawn = [
    { key: "down", field: "net_rx" as const },
    { key: "up", field: "net_tx" as const },
    ...(hasPeak
      ? [
          { key: "downMax", field: "net_rx_max" as const },
          { key: "upMax", field: "net_tx_max" as const },
        ]
      : []),
  ]
  const rates = data.flatMap((row) => drawn.flatMap(({ key, field }) => {
    const value = hidden.includes(key) ? undefined : row[field]
    return typeof value === "number" && value > 0 ? [value] : []
  }))
  const { domain, ticks: rateTicks } = rateAxis(Math.min(...rates), Math.max(...rates, RATE_FLOOR))
  const items: LegendItem[] = [
    { key: "down", label: "下载", color: COLOR.down },
    { key: "up", label: "上传", color: COLOR.up },
    ...(hasPeak
      ? [
          { key: "downMax", label: "下载峰值", color: COLOR.down, dash: "6 3" },
          { key: "upMax", label: "上传峰值", color: COLOR.up, dash: "6 3" },
        ]
      : []),
  ]

  return (
    <ChartCard
      icon={Network}
      tone="net"
      title="实时网络"
      note={live ? (
        <span className="inline-flex items-baseline gap-2">
          <span>↑ {detailRate(live.net_tx)}</span>
          <span>↓ {detailRate(live.net_rx)}</span>
        </span>
      ) : <span>—</span>}
      legend={<ChartLegend label="网络曲线" items={items} hidden={hidden} onToggle={toggle} />}
      empty={items.every((item) => hidden.includes(item.key)) ? NO_SERIES : undefined}
    >
      {items.some((item) => !hidden.includes(item.key)) && (
        <ResponsiveContainer>
          <ComposedChart data={data} margin={MARGIN}>
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(data, hours, ticks)} />
            <YAxis
              scale="log"
              domain={domain}
              ticks={rateTicks}
              tickFormatter={hideZero((value) => `${axisBytes(value)}/s`)}
              {...VALUE_AXIS}
            />
            <Tooltip {...TOOLTIP} formatter={(value) => detailRate(Number(value))} />
            {hasPeak && !hidden.includes("downMax") && (
              <Line dataKey="net_rx_max" name="下载峰值" stroke={COLOR.down} {...PEAK} />
            )}
            {hasPeak && !hidden.includes("upMax") && (
              <Line dataKey="net_tx_max" name="上传峰值" stroke={COLOR.up} {...PEAK} />
            )}
            {!hidden.includes("down") && <Line dataKey="net_rx" name="下载" stroke={COLOR.down} {...LINE} />}
            {!hidden.includes("up") && <Line dataKey="net_tx" name="上传" stroke={COLOR.up} {...LINE} />}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function ConnectionsPanel({ node, rows, hours, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; budget: number; ticks: number }) {
  const { hidden, toggle } = useHidden()
  const data = useMemo(() => decimate(rows, budget, [(row) => row.tcp, (row) => row.udp]), [rows, budget])
  const live = node.metrics
  const { domain, ticks: countTicks } = countAxis(...extent(data.flatMap((row) => [
    ...(hidden.includes("tcp") ? [] : [row.tcp]),
    ...(hidden.includes("udp") ? [] : [row.udp]),
  ])))
  const items: LegendItem[] = [
    { key: "tcp", label: "TCP", color: COLOR.tcp },
    { key: "udp", label: "UDP", color: COLOR.udp },
  ]

  return (
    <ChartCard
      icon={Cable}
      tone="conns"
      title="网络连接"
      note={live ? <span>TCP {live.tcp} · UDP {live.udp}</span> : <span>—</span>}
      legend={<ChartLegend label="连接曲线" items={items} hidden={hidden} onToggle={toggle} />}
      empty={items.every((item) => hidden.includes(item.key)) ? NO_SERIES : undefined}
    >
      {items.some((item) => !hidden.includes(item.key)) && (
        <ResponsiveContainer>
          <LineChart data={data} margin={MARGIN}>
            <CartesianGrid {...GRID} />
            <XAxis {...timeAxis(data, hours, ticks)} />
            {/* Not anchored at zero, and for the same reason the latency card is
                not: these are lines, not areas, so the axis carries no fill to
                be honest about. A box holding 200 sockets and an idle one both
                read as "several hundred" only if the axis starts near them --
                pinned to zero, every second of a day of TCP traffic is a flat
                line at the top of an empty plot. */}
            <YAxis
              domain={domain}
              ticks={countTicks}
              allowDecimals={false}
              tickFormatter={hideZero((value) => String(Math.round(value)))}
              {...VALUE_AXIS}
            />
            <Tooltip {...TOOLTIP} formatter={(value) => Math.round(Number(value))} />
            {!hidden.includes("tcp") && <Line dataKey="tcp" name="TCP" stroke={COLOR.tcp} {...LINE} />}
            {!hidden.includes("udp") && <Line dataKey="udp" name="UDP" stroke={COLOR.udp} {...LINE} />}
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

function ProcessPanel({ node, rows, hours, budget, ticks }: { node: Node; rows: ChartRow[]; hours: number; budget: number; ticks: number }) {
  const live = node.metrics
  const data = useMemo(() => decimate(rows, budget, [(row) => row.procs]), [rows, budget])
  const { domain, ticks: countTicks } = countAxis(...extent(data.map((row) => row.procs)))
  return (
    <ChartCard
      icon={Activity}
      tone="proc"
      title="进程"
      note={<Num value={live ? String(live.procs) : "—"} />}
    >
      <ResponsiveContainer>
        <LineChart data={data} margin={MARGIN}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours, ticks)} />
          {/* `auto` to `auto`, like the connections card: a process count lives
              in a band around its own level, and zero-anchored it drew 240 to
              270 along the top of a plot whose lower third said nothing. */}
          <YAxis
            domain={domain}
            ticks={countTicks}
            allowDecimals={false}
            tickFormatter={hideZero((value) => String(Math.round(value)))}
            {...VALUE_AXIS}
          />
          <Tooltip {...TOOLTIP} formatter={(value) => Math.round(Number(value))} />
          <Line dataKey="procs" name="进程" stroke={COLOR.proc} {...LINE} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/**
 * The grid below is `md:grid-cols-2` with `gap-4`, and the render budget needs
 * the width of *one panel*. Two constants rather than two literals in the middle
 * of an expression: a breakpoint or gap change is then one line, next to the
 * class it mirrors.
 */
const TWO_COLUMNS = 768
const GAP = 16

/**
 * What a panel spends before its plot begins: 34 of card padding and border,
 * the value axis (38 to 56, measured from its own labels) and the chart's 5px
 * right margin. Checked against the rendered panels rather than derived,
 * because it decides a tick count, not a layout: four pixels out moves a label,
 * not a line, and 90 is the wide end -- 34 + 56 -- so the count is never one
 * label more than the plot can hold.
 */
const PANEL_CHROME = 90

/**
 * The six load panels over one row set. The hub already returned time buckets;
 * this only breaks the line where the node was silent, then hands each panel
 * its own colour and axis. It never averages the buckets again.
 */
export function LoadCharts({ node, rows, hours, smooth, live = false }: {
  node: Node
  rows: MetricPoint[]
  hours: number
  smooth: boolean
  /** Live rows mix a one-minute seed with two-second samples; do not read that as an outage. */
  live?: boolean
}) {
  const grid = useRef<HTMLDivElement>(null)
  const width = useElementWidth(grid)
  const panelWidth = width > 0 ? (width >= TWO_COLUMNS ? (width - GAP) / 2 : width) : 0
  const budget = panelWidth > 0 ? renderBudget(panelWidth) : Number.POSITIVE_INFINITY
  const ticks = tickCount(panelWidth - PANEL_CHROME)
  const chart = useMemo(() => (live ? rows : withGaps(rows)).map((row) => (
    "mem_used" in row
      ? { ...row, mem_total: node.mem_total, swap_total: node.swap_total, disk_total: node.disk_total }
      : row
  )) as ChartRow[], [rows, live, node.mem_total, node.swap_total, node.disk_total])
  const hasConns = rows.some((r) => "tcp" in r || "udp" in r)
  const hasProcs = rows.some((r) => "procs" in r)

  return (
    <div ref={grid} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <CpuPanel node={node} rows={chart} hours={hours} smooth={smooth} budget={budget} ticks={ticks} />
      <MemoryPanel node={node} rows={chart} hours={hours} budget={budget} ticks={ticks} />
      <DiskPanel node={node} rows={chart} hours={hours} budget={budget} ticks={ticks} />
      <NetworkPanel node={node} rows={chart} hours={hours} budget={budget} ticks={ticks} />
      {hasConns && <ConnectionsPanel node={node} rows={chart} hours={hours} budget={budget} ticks={ticks} />}
      {hasProcs && <ProcessPanel node={node} rows={chart} hours={hours} budget={budget} ticks={ticks} />}
    </div>
  )
}
