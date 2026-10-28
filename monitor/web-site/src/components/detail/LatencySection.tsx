import { useMemo, useState } from "react"
import { Info } from "lucide-react"
import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

import { Card } from "@/components/ui/card"
import { Chip } from "@/components/ui/chip"
import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { AXIS, GRID, LINE, TOOLTIP, probeStyle, timeAxis } from "@/lib/chart"
import { pingWindows } from "@/lib/format"
import { usePingHistory } from "@/lib/history"
import { buildLatencyRows, probeStats, type ProbeSeries } from "@/lib/pingDetail"
import { cn } from "@/lib/utils"

import { RangeBar } from "./RangeBar"

const ms = (value: number | null) => value === null ? "—" : `${Math.round(value)} ms`
const lossText = (value: number) => value <= 0 ? "0%" : value < 1 ? "<1%" : `${Math.round(value)}%`

/**
 * The latency half: one card per probe, the chart they share, and the two
 * controls that decide what is drawn. The card's figure is the window's average
 * latency, not the newest bucket -- the newest is in the tooltip.
 */
export function LatencySection({ node, historyDays }: { node: Node; historyDays: number }) {
  const ranges = useMemo(() => pingWindows(historyDays), [historyDays])
  const [hours, setHours] = useState(6)
  const [hidden, setHidden] = useState<number[]>([])
  const [smoothPick, setSmoothPick] = useState<boolean | null>(null)
  const smooth = smoothPick ?? hours >= 24
  const answer = usePingHistory(node.id, hours)
  const stepMs = (answer.step || 60) * 1000

  const series = useMemo<ProbeSeries[]>(() => {
    return Object.entries(answer.probes)
      .map(([key, name]) => {
        const id = Number(key)
        if (!Number.isFinite(id)) return null
        const points = answer.rows.filter((row) => row.task_id === id)
        if (!points.length) return null
        return { id, name: name || `探测 ${id}`, points, loss: answer.loss[String(id)] ?? 0 }
      })
      .filter((item): item is ProbeSeries => item !== null)
      .sort((a, b) => a.id - b.id)
  }, [answer.probes, answer.rows, answer.loss])

  const stats = useMemo(() => series.map(probeStats), [series])
  // A hidden id from another node or range must not make "all shown" false.
  const visibleHidden = hidden.filter((id) => series.some((probe) => probe.id === id))
  const shown = series.filter((probe) => !visibleHidden.includes(probe.id))
  const rows = useMemo(() => buildLatencyRows(series, smooth, stepMs), [series, smooth, stepMs])
  const allShown = visibleHidden.length === 0
  const noneShown = series.length > 0 && visibleHidden.length >= series.length

  const toggle = (id: number) => {
    setHidden((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
  }

  return (
    <section className="space-y-3" aria-label="网络延迟">
      <RangeBar
        ranges={ranges}
        value={hours}
        allowLive={false}
        onChange={(next) => { if (typeof next === "number") setHours(next) }}
        right={(
          <div className="flex shrink-0 items-center gap-1">
            <Chip pressed={allShown} onClick={() => setHidden([])} aria-label="全选探测">全选</Chip>
            <Chip pressed={noneShown} onClick={() => setHidden(series.map((probe) => probe.id))} aria-label="全不选探测">全不选</Chip>
          </div>
        )}
      />

      {answer.loading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      )}

      {answer.error && (
        <p className="py-8 text-center text-sm text-destructive" role="alert">
          获取数据失败：{answer.error}
          <button
            className="ml-2 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={answer.retry}
          >重试</button>
        </p>
      )}

      {!answer.loading && !answer.error && series.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无延迟数据</p>
      )}

      {series.length > 0 && (
        <>
          <div className="flex flex-wrap gap-3">
            {stats.map((stat, index) => {
              const style = probeStyle(index)
              const on = !visibleHidden.includes(stat.id)
              const info = [
                `最小 ${ms(stat.min)}`,
                `最大 ${ms(stat.max)}`,
                `平均 ${ms(stat.avg)}`,
                `最新 ${ms(stat.latest)}`,
                `P50 ${ms(stat.p50)}`,
                `P99 ${ms(stat.p99)}`,
                `波动率 ${stat.volatility === null ? "—" : stat.volatility.toFixed(2)}`,
                `样本 ${stat.samples} · 有效 ${stat.valid}`,
                `丢包 ${lossText(stat.loss)}`,
              ].join("\n")
              return (
                <button
                  key={stat.id}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${stat.name}，${on ? "已显示" : "已隐藏"}；平均延迟 ${ms(stat.avg)}，丢包 ${lossText(stat.loss)}`}
                  onClick={() => toggle(stat.id)}
                  className={cn(
                    "group flex min-w-48 flex-1 items-center gap-3 rounded-lg bg-card-2 p-3 text-left transition-opacity hover:bg-card",
                    !on && "opacity-30",
                  )}
                >
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: style.stroke }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">{stat.name}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground" title={info} aria-label={info}>
                        <Info size={14} aria-hidden />
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-muted-foreground">
                      <span>平均 {ms(stat.avg)}</span>
                      <span>·</span>
                      <span>丢包 {lossText(stat.loss)}</span>
                      <span>·</span>
                      <span>波动 {stat.volatility === null ? "—" : stat.volatility.toFixed(2)}</span>
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          <Card className="min-w-0 gap-0 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">延迟</h3>
                <p className="text-3xs text-muted-foreground">每桶中位数 · 毫秒</p>
              </div>
              <Chip
                pressed={smooth}
                onClick={() => setSmoothPick(!smooth)}
                title="按邻点中位数削去单点尖峰"
              >
                平滑峰值
              </Chip>
            </div>
            <div className="mt-2 h-80 text-muted-foreground">
              {shown.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <ResponsiveContainer>
                  <ComposedChart data={rows}>
                    <CartesianGrid {...GRID} />
                    <XAxis {...timeAxis(rows, hours)} />
                    {/* Not anchored at zero: these lines live in a narrow band
                        far from it, and zero flattens every wobble. */}
                    <YAxis unit="ms" width={52} domain={["auto", "auto"]} {...AXIS} />
                    <Tooltip
                      {...TOOLTIP}
                      formatter={(value, name, item) => {
                        const loss = Number(item?.payload?.[`l${String(item.dataKey).slice(1)}`] ?? 0)
                        return [`${Math.round(Number(value))} ms${loss > 0 ? ` · 丢 ${loss}%` : ""}`, name]
                      }}
                    />
                    {/* Behind a single line, the range that bucket's answers
                        spanned. With more than one probe the bands overlap into
                        a fog, so only one is ever drawn. */}
                    {shown.length === 1 && shown.map((probe) => (
                      <Area
                        key={`band${probe.id}`}
                        dataKey={`${smooth ? "c" : "b"}${probe.id}`}
                        stroke="none"
                        fill={probeStyle(series.findIndex((item) => item.id === probe.id)).stroke}
                        fillOpacity={0.16}
                        isAnimationActive={false}
                        tooltipType="none"
                        legendType="none"
                        connectNulls={false}
                      />
                    ))}
                    {shown.map((probe) => {
                      const style = probeStyle(series.findIndex((item) => item.id === probe.id))
                      return (
                        <Line
                          key={probe.id}
                          dataKey={`${smooth ? "s" : "t"}${probe.id}`}
                          name={probe.name}
                          stroke={style.stroke}
                          strokeDasharray={style.dash}
                          {...LINE}
                          connectNulls={false}
                        />
                      )
                    })}
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </>
      )}
    </section>
  )
}
