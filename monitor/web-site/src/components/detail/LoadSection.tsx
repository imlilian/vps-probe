import { useMemo, useState } from "react"

import { Card } from "@/components/ui/card"
import { Chip } from "@/components/ui/chip"
import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { loadWindows } from "@/lib/format"
import { useMetricsHistory } from "@/lib/history"
import { toLive, useLiveSamples, type LiveRow } from "@/lib/live"

import { LoadCharts } from "./LoadCharts"
import { RangeBar } from "./RangeBar"

type Range = "live" | number

/**
 * The whole load half of the page: one range, one request, six panels.
 *
 * The request asks for a time bucket, not a pixel count -- 4h is 240 one-minute
 * buckets, 30d is 180 four-hour ones. The panels only normalize the answer; the
 * hub has already done the statistics.
 */
export function LoadSection({ node, historyDays }: { node: Node; historyDays: number }) {
  const ranges = useMemo(() => loadWindows(historyDays), [historyDays])
  const [range, setRange] = useState<Range>(4)
  const [smoothPick, setSmoothPick] = useState<boolean | null>(null)
  const history = useMetricsHistory(node.id, range === "live" ? 0 : range, range !== "live")
  // The live buffer starts from the last few history buckets, so clicking 实时
  // does not show a single flat segment while the stream catches up. Only for
  // windows whose buckets are minutes, not hours.
  const [seed, setSeed] = useState<{ id: number; rows: LiveRow[] }>({ id: node.id, rows: [] })
  const seedRows = seed.id === node.id ? seed.rows : []
  const live = useLiveSamples(node.id, node.metrics, seedRows)
  const rows = range === "live" ? live : history.rows
  const smooth = range === "live" ? false : (smoothPick ?? range >= 24)

  const choose = (next: Range) => {
    if (next === "live" && range !== "live" && range <= 24 && history.rows.length > 0) {
      setSeed({ id: node.id, rows: history.rows.slice(-5).map(toLive) })
    }
    setRange(next)
    // A range change is a new question; a skeleton is better than the previous
    // window's line still drawing under the new label.
    if (next !== "live") setSmoothPick(null)
  }

  return (
    <section className="space-y-4" aria-label="负载">
      <RangeBar
        ranges={ranges}
        value={range}
        onChange={choose}
        right={range !== "live" ? (
          <Chip
            pressed={smooth}
            onClick={() => setSmoothPick(!smooth)}
            title="按邻点中位数削去单点尖峰；网络不削，保留真实突发"
          >
            削峰
          </Chip>
        ) : undefined}
      />

      {range !== "live" && history.loading && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i} className="min-w-0 gap-0 p-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-48 w-full" />
            </Card>
          ))}
        </div>
      )}

      {range !== "live" && history.error && (
        <p className="py-8 text-center text-sm text-destructive" role="alert">
          读取历史数据失败：{history.error}
          <button
            className="ml-2 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={history.retry}
          >重试</button>
        </p>
      )}

      {range === "live" && live.length < 2 && (
        <p className="py-8 text-center text-sm text-muted-foreground">正在积累实时样本（最近 5 分钟，每 2 秒一点）</p>
      )}

      {range !== "live" && !history.loading && !history.error && rows.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">这段时间没有历史数据</p>
      )}

      {rows.length > 0 && (
        <LoadCharts
          node={node}
          rows={rows}
          hours={range === "live" ? 0 : range}
          smooth={smooth}
          live={range === "live"}
        />
      )}
    </section>
  )
}
