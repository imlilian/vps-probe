import { useMemo, useRef, useState } from "react"
import { Activity, Cable, Cpu, HardDrive, MemoryStick, Network } from "lucide-react"
import {
  Area, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

import { ChartFade } from "./ChartFade"
import type { Node } from "@/lib/api"
import {
  AXIS, COLOR, CPU_TICKS, DERIVED, GRID, LINE, PEAK, TOOLTIP, VALUE_AXIS, timeAxis,
} from "@/lib/chart"
import { detailBytes, detailRate, diskForecast } from "@/lib/detail"
import { decimate } from "@/lib/downsample"
import { axisBytes, despike, quarters, RATE_FLOOR, rateAxis, withGaps } from "@/lib/format"
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

/** A despike window in samples, by the bucket's duration rather than a count. */
function windowFor(rows: { ts: number }[]): number {
  let step = Infinity
  for (let i = 1; i < rows.length; i++) step = Math.min(step, rows[i].ts - rows[i - 1].ts)
  return Math.min(15, Math.max(3, Math.round(420_000 / step) | 1))
}

function useHidden() {
  const [hidden, setHidden] = useState<string[]>([])
  return {
    hidden,
    toggle: (key: string) => setHidden((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key])),
  }
}

function CpuPanel({ node, rows, hours, smooth, budget }: { node: Node; rows: ChartRow[]; hours: number; smooth: boolean; budget: number }) {
  const { hidden, toggle } = useHidden()
  const hasPeak = rows.some((r) => (r.cpu_max ?? 0) > 0)
  const data = useMemo(() => decimate(rows, budget, [
    (row) => row.cpu,
    ...(hasPeak ? [(row: ChartRow) => row.cpu_max] : []),
  ]), [rows, budget, hasPeak])
  const chart = useMemo(() => {
    if (!smooth) return data
    const cleaned = despike(data.map((r) => ("cpu" in r ? r.cpu : null)), windowFor(data))
    return data.map((r, i) => ({ ...r, cpu_s: cleaned[i] }))
  }, [data, smooth])
  const live = node.metrics
  const items: LegendItem[] = [
    { key: "cpu", label: "CPU", color: COLOR.cpu },
    ...(hasPeak ? [{ key: "peak", label: "峰值", color: COLOR.cpu, dash: "6 3" }] : []),
  ]

  return (
    <ChartCard
      icon={Cpu}
      tone="cpu"
      title="CPU"
      note={live ? <Num value={live.cpu.toFixed(1)} unit="%" /> : <span>—</span>}
      legend={<ChartLegend label="CPU 曲线" items={items} hidden={hidden} onToggle={toggle} />}
    >
      <ResponsiveContainer>
        <ComposedChart data={chart}>
          <ChartFade id="fade-cpu" color={COLOR.cpu} />
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(chart, hours)} />
          <YAxis domain={[0, 100]} ticks={CPU_TICKS} unit="%" {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]} />
          {!hidden.includes("cpu") && (
            <Area dataKey={smooth ? "cpu_s" : "cpu"} name="CPU" stroke={COLOR.cpu} fill="url(#fade-cpu)" {...LINE} />
          )}
          {hasPeak && !hidden.includes("peak") && (
            <Line dataKey="cpu_max" name="峰值" stroke={COLOR.cpu} {...PEAK} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function MemoryPanel({ node, rows, hours, budget }: { node: Node; rows: ChartRow[]; hours: number; budget: number }) {
  const { hidden, toggle } = useHidden()
  const hasSwap = node.swap_total > 0 && rows.some((r) => "swap_used" in r)
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
    >
      <ResponsiveContainer>
        <ComposedChart data={data}>
          <ChartFade id="fade-mem" color={COLOR.mem} />
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours)} />
          <YAxis domain={[0, node.mem_total]} ticks={quarters(node.mem_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} formatter={(value) => detailBytes(Number(value))} />
          {!hidden.includes("memTotal") && (
            <Line dataKey="mem_total" name="RAM 总量" stroke={COLOR.memTotal} {...DERIVED} />
          )}
          {hasSwap && !hidden.includes("swapTotal") && (
            <Line dataKey="swap_total" name="Swap 总量" stroke={COLOR.swapTotal} {...DERIVED} />
          )}
          {!hidden.includes("mem") && (
            <Area dataKey="mem_used" name="RAM" stroke={COLOR.mem} fill="url(#fade-mem)" {...LINE} />
          )}
          {hasSwap && !hidden.includes("swap") && (
            <Line dataKey="swap_used" name="Swap" stroke={COLOR.swap} {...LINE} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function DiskPanel({ node, rows, hours, budget }: { node: Node; rows: ChartRow[]; hours: number; budget: number }) {
  const { hidden, toggle } = useHidden()
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
    >
      <ResponsiveContainer>
        <ComposedChart data={data}>
          <ChartFade id="fade-disk" color={COLOR.disk} />
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours)} />
          <YAxis domain={[0, node.disk_total]} ticks={quarters(node.disk_total)} tickFormatter={axisBytes} {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} formatter={(value) => detailBytes(Number(value))} />
          {!hidden.includes("diskTotal") && (
            <Line dataKey="disk_total" name="磁盘总量" stroke={COLOR.diskTotal} {...DERIVED} />
          )}
          {!hidden.includes("disk") && (
            <Area dataKey="disk_used" name="磁盘已用" stroke={COLOR.disk} fill="url(#fade-disk)" {...LINE} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function NetworkPanel({ node, rows, hours, budget }: { node: Node; rows: ChartRow[]; hours: number; budget: number }) {
  const { hidden, toggle } = useHidden()
  const hasPeak = rows.some((r) => (r.net_rx_max ?? 0) > 0 || (r.net_tx_max ?? 0) > 0)
  const data = useMemo(() => decimate(rows, budget, [
    (row) => row.net_rx,
    (row) => row.net_tx,
    ...(hasPeak ? [(row: ChartRow) => row.net_rx_max, (row: ChartRow) => row.net_tx_max] : []),
  ]), [rows, budget, hasPeak])
  const live = node.metrics
  const max = rows.reduce((hi, r) => Math.max(hi, r.net_rx_max ?? r.net_rx ?? 0, r.net_tx_max ?? r.net_tx ?? 0), RATE_FLOOR)
  const { domain, ticks } = rateAxis(RATE_FLOOR, max)
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
    >
      <ResponsiveContainer>
        <ComposedChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours)} />
          <YAxis
            scale="log"
            domain={domain}
            ticks={ticks}
            tickFormatter={axisBytes}
            unit="/s"
            {...AXIS}
            width={80}
            interval={0}
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
    </ChartCard>
  )
}

function ConnectionsPanel({ node, rows, hours, budget }: { node: Node; rows: ChartRow[]; hours: number; budget: number }) {
  const { hidden, toggle } = useHidden()
  const data = useMemo(() => decimate(rows, budget, [(row) => row.tcp, (row) => row.udp]), [rows, budget])
  const live = node.metrics
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
    >
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours)} />
          <YAxis domain={[0, "auto"]} allowDecimals={false} {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} formatter={(value) => Math.round(Number(value))} />
          {!hidden.includes("tcp") && <Line dataKey="tcp" name="TCP" stroke={COLOR.tcp} {...LINE} />}
          {!hidden.includes("udp") && <Line dataKey="udp" name="UDP" stroke={COLOR.udp} {...LINE} />}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

function ProcessPanel({ node, rows, hours, budget }: { node: Node; rows: ChartRow[]; hours: number; budget: number }) {
  const live = node.metrics
  const data = useMemo(() => decimate(rows, budget, [(row) => row.procs]), [rows, budget])
  return (
    <ChartCard
      icon={Activity}
      tone="proc"
      title="进程"
      note={<Num value={live ? String(live.procs) : "—"} />}
    >
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid {...GRID} />
          <XAxis {...timeAxis(data, hours)} />
          <YAxis domain={[0, "auto"]} allowDecimals={false} {...VALUE_AXIS} />
          <Tooltip {...TOOLTIP} formatter={(value) => Math.round(Number(value))} />
          <Line dataKey="procs" name="进程" stroke={COLOR.proc} {...LINE} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

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
  const panelWidth = width > 0 ? (width >= 768 ? (width - 16) / 2 : width) : 0
  const budget = panelWidth > 0 ? renderBudget(panelWidth) : Number.POSITIVE_INFINITY
  const chart = useMemo(() => (live ? rows : withGaps(rows)).map((row) => (
    "mem_used" in row
      ? { ...row, mem_total: node.mem_total, swap_total: node.swap_total, disk_total: node.disk_total }
      : row
  )) as ChartRow[], [rows, live, node.mem_total, node.swap_total, node.disk_total])
  const hasConns = rows.some((r) => "tcp" in r || "udp" in r)
  const hasProcs = rows.some((r) => "procs" in r)

  return (
    <div ref={grid} className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <CpuPanel node={node} rows={chart} hours={hours} smooth={smooth} budget={budget} />
      <MemoryPanel node={node} rows={chart} hours={hours} budget={budget} />
      <DiskPanel node={node} rows={chart} hours={hours} budget={budget} />
      <NetworkPanel node={node} rows={chart} hours={hours} budget={budget} />
      {hasConns && <ConnectionsPanel node={node} rows={chart} hours={hours} budget={budget} />}
      {hasProcs && <ProcessPanel node={node} rows={chart} hours={hours} budget={budget} />}
    </div>
  )
}
