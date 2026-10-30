import { Info } from "lucide-react"

import { SignalStrip, QUALITY_FILL, QUALITY_LEGEND, qualityFill } from "@/components/SignalStrip"
import { Card } from "@/components/ui/card"
import { clockFor } from "@/lib/format"
import { buildSlots, fmtLoss, fmtPct, qualityBlocks } from "@/lib/ping"
import type { ProbeSeries } from "@/lib/pingDetail"
import { cn } from "@/lib/utils"

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

  return (
    <Card className="min-w-0 gap-0 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">线路质量</h3>
          <p className="text-3xs text-muted-foreground">首包重传与丢包 · 每块 {window.label}</p>
        </div>
        <span className="shrink-0 text-muted-foreground" role="img" title={EXPLAIN} aria-label={EXPLAIN}>
          <Info size={14} aria-hidden />
        </span>
      </div>

      <div className="mt-2 space-y-1">
        {series.map((probe) => {
          // Blocks of seconds, from the buckets the chart above is drawn from:
          // one fold for the card and the detail page alike.
          const slots = buildSlots(probe.points, until, window.count, window.seconds)
          const on = !hidden.includes(probe.id)
          return (
            <div
              key={probe.id}
              className={cn("grid grid-cols-[1fr_auto_1fr] items-center gap-2", !on && "opacity-30")}
              aria-label={`${probe.name}，重传 ${pct(probe.retx ?? null)}，丢包 ${pct(probe.loss)}`}
            >
              <span className="truncate text-2xs text-muted-foreground">{probe.name}</span>
              {/* Retransmit always, loss only when there was one: a clean line
                  spends no column on a dash, and the strip beside it is green
                  end to end. */}
              <span className="tnum shrink-0 text-right text-2xs">
                <span className={cn("font-medium", probe.retx ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
                  RTX {fmtPct(probe.retx ?? null)}
                </span>
                {probe.loss > 0 && (
                  <>
                    <span aria-hidden className="text-border"> · </span>
                    <span className="font-medium text-red-700 dark:text-red-400">LOSS {fmtPct(probe.loss)}</span>
                  </>
                )}
              </span>
              <SignalStrip
                slots={slots}
                clock={clock}
                fill={qualityFill}
                style={{ gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))` }}
              />
            </div>
          )
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-muted-foreground">
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
