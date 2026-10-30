import { useMemo, useState } from "react"
import { Info, Timer } from "lucide-react"
import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts"

import { Card } from "@/components/ui/card"
import { Chip } from "@/components/ui/chip"
import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { AXIS, GRID, hideZero, LINE, TOOLTIP, probeStyle, timeAxis } from "@/lib/chart"
import { pingWindows } from "@/lib/format"
import { fmtLoss, fmtPct } from "@/lib/ping"
import { usePingHistory } from "@/lib/history"
import { useInView } from "@/lib/useInView"
import { buildLatencyRows, probeStats, type ProbeSeries, type ProbeStat } from "@/lib/pingDetail"
import { cn } from "@/lib/utils"

import { IconTile } from "./ChartCard"
import { QualitySection } from "./QualitySection"
import { RangeBar } from "./RangeBar"

const ms = (value: number | null) => value === null ? "—" : `${Math.round(value)} ms`

/** A bucket's length as the chart's subtitle says it: 5 分钟, 1 小时. */
const span = (seconds: number) =>
  seconds >= 3_600 ? `${Math.round(seconds / 3_600)} 小时` : `${Math.round(seconds / 60)} 分钟`

/**
 * A percentage as a screen reader hears it: the card's own precision, and zero
 * spoken as zero.
 *
 * The panels print a dash where there is nothing to report (`fmtPct`), which is
 * the right mark on a row of figures and the wrong thing to read out -- "-" is
 * not a number. The visible row and the spoken sentence therefore differ by
 * exactly this: a dash on screen, `0%` in the label.
 */
const spokenPct = (value: number) => `${fmtLoss(value)}%`

/**
 * One probe's card: the colour that keys it to the chart, then the three numbers
 * a reader acts on, then the two that say how often the line went wrong.
 *
 * `AVG` and `MIN`/`MAX` rather than `延迟` and `P50`/`P99`. The chart below is
 * titled 延迟, so the word was a caption for a caption; and a public page that
 * says P50 and P99 asks the visitor to know what a percentile is before they can
 * read their own machine's card. The percentiles are still in the ⓘ, where they
 * are what answers "how bad is the bad part" for anyone who asks.
 *
 * The two failure figures are labelled in Latin -- LOSS and RETR -- because they
 * sit in a row of columns where a two-word Chinese label is both wider and, in
 * another language, unbounded. The words live in the tooltip and in the spoken
 * label, which is where they are read rather than measured.
 *
 * The split is the point. `平均 51 ms · 丢包 0% · 波动 1.42` was four figures and
 * a verb in one grey run, and the figure a reader compares across probes was
 * buried in the middle of it. Those two rows are also where `重传` first appears
 * on the page -- a hub that does not produce it gets one row fewer here and no
 * quality card at all, rather than a zero nobody can act on.
 *
 * Everything else -- the window's extremes, the spread, the sample counts --
 * stays in the ⓘ: it is what a reader asks *after* the three numbers, and it is
 * one press away.
 */
export function ProbeCard({ stat, color, on, onClick }: {
  stat: ProbeStat
  /** The probe's line colour on the chart above. */
  color: string
  on: boolean
  onClick: () => void
}) {
  // Only where the hub produces it: `重传 —` would be a figure with its value
  // missing, where the truth is that this hub has no such column.
  const retxInfo = stat.retx === null ? [] : [`重传 ${spokenPct(stat.retx)}`]
  const spoken = [
    `${stat.name}，${on ? "已显示" : "已隐藏"}；延迟 ${ms(stat.avg)}，P50 ${ms(stat.p50)}，P99 ${ms(stat.p99)}`,
    ...retxInfo,
    `丢包 ${spokenPct(stat.loss)}，样本 ${stat.samples}`,
  ].join("，")
  // The printed row reads RETR before LOSS -- mild before severe, the order the
  // legend and the card use -- so the sentence does too.
  const info = [
    `最小 ${ms(stat.min)}`,
    `最大 ${ms(stat.max)}`,
    `平均 ${ms(stat.avg)}`,
    `最新 ${ms(stat.latest)}`,
    `P50 ${ms(stat.p50)}`,
    `P99 ${ms(stat.p99)}`,
    `波动率 ${stat.volatility === null ? "—" : stat.volatility.toFixed(2)}`,
    `样本 ${stat.samples} · 有效 ${stat.valid}`,
    ...retxInfo,
    `丢包 ${spokenPct(stat.loss)}`,
  ].join("\n")
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={spoken}
      onClick={onClick}
      className={cn(
        "group flex min-w-48 flex-1 items-center gap-3 rounded-lg bg-card-2 p-3 text-left transition-opacity hover:bg-card",
        !on && "opacity-30",
      )}
    >
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{stat.name}</span>
          <span className="ml-auto shrink-0 text-muted-foreground" role="img" title={info} aria-label={info}>
            <Info size={14} aria-hidden />
          </span>
        </span>
        <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-muted-foreground">
          <span>AVG {ms(stat.avg)}</span>
          <span>·</span>
          <span>MIN {ms(stat.min)} / MAX {ms(stat.max)}</span>
        </span>
        {/* The retransmit rate always, the loss only when there was one -- the
            same rule as the card's rows, so a clean line never spends a column
            on a dash. A hub without the retransmit figure has only the loss to
            show, and shows nothing at all when it is zero. */}
        <span className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-2xs text-muted-foreground">
          {stat.retx !== null && <span>RETR {fmtPct(stat.retx)}</span>}
          {stat.retx !== null && stat.loss > 0 && <span>·</span>}
          {stat.loss > 0 && <span>LOSS {fmtPct(stat.loss)}</span>}
        </span>
      </span>
    </button>
  )
}

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
  const [sectionRef, seen] = useInView<HTMLElement>()
  const answer = usePingHistory(node.id, hours, seen)
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
    <section ref={sectionRef} className="space-y-3" aria-label="网络延迟">
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

      {!seen && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      )}

      {seen && answer.loading && (
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
            {stats.map((stat, index) => (
              <ProbeCard
                key={stat.id}
                stat={stat}
                color={probeStyle(index).stroke}
                on={!visibleHidden.includes(stat.id)}
                onClick={() => toggle(stat.id)}
              />
            ))}
          </div>

          <Card className="min-w-0 gap-0 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* The same icon tile the six charts above open with: a page where
                  four charts are titled with a glyph and the two below them with
                  bare text reads as two different pages.
                  
                  The bucket's own length rides beside the title rather than under
                  it -- it comes from the answer rather than a constant, and the
                  unit is on the axis below. A caption on its own line under a 14px
                  heading is what read as a draft. */}
              <div className="flex min-w-0 items-center gap-2.5">
                <IconTile icon={Timer} tone="latency" />
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <h3 className="text-sm font-semibold">延迟</h3>
                  <span className="text-2xs text-muted-foreground">每 {span(answer.step || 60)} 的中位数</span>
                </div>
              </div>
              <Chip
                pressed={smooth}
                onClick={() => setSmoothPick(!smooth)}
                title="按邻点中位数削去单点尖峰"
              >
                平滑峰值
              </Chip>
            </div>
            <div className="mt-4 h-80 text-muted-foreground" role="img" aria-label="延迟曲线">
              {shown.length === 0 ? (
                <p className="py-8 text-center text-sm">没有选中任何探测</p>
              ) : (
                <ResponsiveContainer>
                  <ComposedChart data={rows}>
                    <CartesianGrid {...GRID} />
                    <XAxis {...timeAxis(rows, hours)} />
                    {/* Not anchored at zero: these lines live in a narrow band
                        far from it, and zero flattens every wobble. */}
                    {/* 48px: enough for `180ms` and for the first clock tick's
                        label to hang beside it -- an axis fitted exactly to its
                        own text (`width="auto"`) leaves the time label nowhere to
                        go. No label at zero: the first clock tick sits in the
                        corner directly below it, and two labels for one gap read
                        as a collision. The baseline stays, so a line at rest hugs
                        the floor rather than floating. */}
                    <YAxis
                      width={48}
                      domain={["auto", "auto"]}
                      tickFormatter={hideZero((value) => `${Math.round(value)}ms`)}
                      {...AXIS}
                    />
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

          {/* A hub from before the metric answers without a `retx` figure, and
              the card is left off rather than drawn at zero: an empty strip of
              quiet green would be a claim this hub cannot make. */}
          {answer.retx !== undefined && (
            <QualitySection series={series} hidden={visibleHidden} hours={hours} />
          )}
        </>
      )}
    </section>
  )
}
