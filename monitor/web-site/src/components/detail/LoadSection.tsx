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
 * No seed at all, as one array for the life of the module: a literal `[]` here
 * would be a new object on every render, and the buffer's effect compares its
 * seed by identity -- switching machines while 实时 is open would then re-enter
 * the effect on every commit, set state, and commit again.
 */
const NO_SEED: LiveRow[] = []

/** How much history a realtime trace borrows so it is not one point at first. */
const SEED_SPAN = 5 * 60_000

/**
 * The whole load half of the page: one range, one request, six panels.
 *
 * The request asks for a time bucket, not a pixel count -- 4h is 240 one-minute
 * buckets, 30d is 180 four-hour ones. The panels only normalize the answer; the
 * hub has already done the statistics.
 */
export function LoadSection({ node, at = 0, historyDays }: {
  node: Node
  /** The frame's own millisecond, for the realtime buffer's time axis. */
  at?: number
  historyDays: number
}) {
  const ranges = useMemo(() => loadWindows(historyDays), [historyDays])
  const [range, setRange] = useState<Range>(4)
  const [smoothPick, setSmoothPick] = useState<boolean | null>(null)
  const history = useMetricsHistory(node.id, range === "live" ? 0 : range, range !== "live")
  // The live buffer starts from the history already on screen, so clicking 实时
  // does not show a single point while the stream catches up. Only rows inside
  // the trace's own five minutes: at 1 天 the buckets are ten minutes wide and
  // five of them would stretch the "last five minutes" over an hour.
  const [seed, setSeed] = useState<{ id: number; rows: LiveRow[] }>({ id: node.id, rows: NO_SEED })
  const seedRows = seed.id === node.id ? seed.rows : NO_SEED
  // Only the realtime range needs a buffer. Passing null elsewhere keeps the
  // page from re-rendering the six charts every two seconds on behalf of a
  // trace nobody is looking at -- and from spending the samples it would need
  // if the reader does click 实时 later (that is what the seed below is for).
  const live = useLiveSamples(node.id, range === "live" ? node.metrics : null, at, seedRows)
  const rows = range === "live" ? live : history.rows
  const smooth = range === "live" ? false : (smoothPick ?? range >= 24)

  const choose = (next: Range) => {
    if (next === "live" && range !== "live" && history.rows.length > 0) {
      const recent = history.rows.slice(-6).map(toLive)
      const newest = recent.at(-1)!.ts
      setSeed({ id: node.id, rows: recent.filter((row) => row.ts >= newest - SEED_SPAN) })
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
