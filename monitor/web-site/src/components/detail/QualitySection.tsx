import { Gauge, Info } from "lucide-react"

import { SignalStrip, QUALITY_FILL, QUALITY_LEGEND, qualityFill } from "@/components/SignalStrip"
import { Card } from "@/components/ui/card"
import { clockFor } from "@/lib/format"
import { buildSlots, fmtLoss, fmtPct, qualityBlocks } from "@/lib/ping"
import type { ProbeSeries } from "@/lib/pingDetail"
import { cn } from "@/lib/utils"

import { IconTile } from "./ChartCard"

/**
 * What the two figures mean, said once on the page and nowhere else.
 *
 * The card's strips carry the same colour language with no room for a sentence;
 * this is where a reader who wants to know what amber means finds out. It lives
 * on the quality card's own ⓘ because that is where the words are needed first.
 */
const EXPLAIN = [
  "延迟是首包往返时间（已扣除重传等待）。",
  "重传：丢了一个 SYN，内核 1 秒后重传救回来了 —— 对使用几乎没有影响，但说明这条线路在丢包。",
  "丢包：3 秒内连不上，这一分钟没有数据。",
].join("\n")

/** The card's own precision, so both surfaces print the same line the same way. */
const pct = (value: number | null) => value === null ? "—" : `${fmtLoss(value)}%`

/**
 * The quality card: the same twenty-or-so blocks as the card, one row per probe,
 * over whatever window the latency chart above is drawing.
 *
 * A strip and not a line. A retransmit is a sparse event -- a few per cent of
 * samples -- so a line through it is flat at zero with isolated needles, which
 * says neither when an episode started nor how long it lasted. A row of blocks
 * says both, and it is the language the card already taught the reader.
 *
 * The window follows the range bar above (`hours`), and the block length follows
 * the window (`qualityBlocks`), so the title can name it honestly at every stop.
 * Hidden probes are dimmed rather than dropped: the state is the chart's, and a
 * reader comparing two links does not want the numbers to disappear when the
 * other line is hidden.
 */
export function QualitySection({ series, hidden, hours }: {
  series: ProbeSeries[]
  hidden: number[]
  hours: number
}) {
  if (!series.length) return null
  // Every probe's newest bucket, so the strip's right edge is the last block the
  // hub has, not the visitor's clock -- the same rule the card follows.
  const newest = series.reduce((hi, probe) => {
    const last = probe.points.at(-1)?.ts ?? 0
    return Math.max(hi, last)
  }, 0)
  if (!newest) return null
  const window = qualityBlocks(hours * 3_600)
  const blockMs = window.seconds * 1000
  const until = Math.ceil(newest / blockMs) * blockMs
  const clock = clockFor(hours)
  // `buildSlots` folds by whatever unit it is handed, and every other caller
  // hands it seconds -- the card's rows come off the hub in seconds, these come
  // from `toPing`, which made them milliseconds for the chart above. Passing the
  // window's seconds beside millisecond stamps put every bucket outside the fold
  // and drew an hour of nothing: a strip of grey blocks that looked like no data
  // rather than like a bug.
  const at = (ts: number) => Math.round(ts / 1000)

  return (
    <Card className="min-w-0 gap-0 p-4">
      <div className="flex items-start justify-between gap-2">
        {/* The block length rides beside the title rather than on a line of its
            own: a caption under a 14px heading reads as a draft, and on a phone
            the second line wraps first and leaves the heading alone. What the two
            figures mean is the ⓘ's job, in a sentence. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Gauge} tone="quality" />
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h3 className="text-sm font-semibold">线路质量</h3>
            <span className="text-2xs text-muted-foreground">每块 {window.label}</span>
          </div>
        </div>
        <span className="shrink-0 text-muted-foreground" role="img" title={EXPLAIN} aria-label={EXPLAIN}>
          <Info size={14} aria-hidden />
        </span>
      </div>

      {/* Two lines per probe, the card's own rhythm: the figures above, the
          strip across the full width below.
          
          It was one row -- name, figures, strip -- which reads well at 1400px and
          falls apart on a phone, where the strip is the third column of a grid
          and gets whatever the two labels leave. The strip is the subject; it
          gets the width, and the blocks line up down the card because every row
          starts at the same x. */}
      <div className="mt-4 space-y-2">
        {series.map((probe) => {
          // Blocks of seconds, from the buckets the chart above is drawn from:
          // one fold for the card and the detail page alike.
          const slots = buildSlots(
            probe.points.map((point) => ({ ...point, ts: at(point.ts) })),
            at(until),
            window.count,
            window.seconds,
          )
          const on = !hidden.includes(probe.id)
          return (
            <div
              key={probe.id}
              className={cn("min-w-0", !on && "opacity-30")}
              aria-label={`${probe.name}，重传 ${pct(probe.retx ?? null)}，丢包 ${pct(probe.loss)}`}
            >
              <div className="flex items-baseline justify-between gap-2 text-2xs">
                <span className="truncate text-muted-foreground">{probe.name}</span>
                {/* Retransmit always, loss only when there was one: a clean line
                    spends no column on a dash. */}
                <span className="tnum shrink-0">
                  <span className={cn("font-medium", probe.retx ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                    RETR {fmtPct(probe.retx ?? null)}
                  </span>
                  {probe.loss > 0 && (
                    <>
                      <span aria-hidden className="text-border"> · </span>
                      <span className="font-medium text-red-700 dark:text-red-400">LOSS {fmtPct(probe.loss)}</span>
                    </>
                  )}
                </span>
              </div>
              <SignalStrip
                slots={slots}
                clock={clock}
                fill={qualityFill}
                className="mt-1"
                style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-3xs text-muted-foreground">
        {QUALITY_LEGEND.map(({ quality, label }) => (
          <span key={quality} className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 shrink-0 rounded-xs", QUALITY_FILL[quality])} aria-hidden />
            {label}
          </span>
        ))}
      </div>
    </Card>
  )
}
