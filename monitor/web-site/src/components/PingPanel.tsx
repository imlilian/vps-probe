import { useEffect, useRef, useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { clockFor } from "@/lib/format"
import {
  cardProbes, fmtLoss, fmtMs, HOURS, lossSignal, probeLatencySignal, slotSignal,
  useNodePing, type ProbeStats, type Slot,
} from "@/lib/ping"
import { cn } from "@/lib/utils"

/**
 * Five steps as Tailwind palette steps rather than literal colours: the block is
 * a fill, so it needs 3:1 against the card and nothing more, while the figure
 * beside it is text and takes a darker step of the same hue elsewhere.
 *
 * Colour is kept for trouble. Steps 1 and 2 are the faintest green the palette
 * has, so a glance down a page of cards lands on the few amber and red blocks
 * instead of on hundreds of green ones.
 */
const FILL = [
  "bg-muted", // 0: no samples
  "bg-emerald-200 dark:bg-emerald-500/30",
  "bg-emerald-300 dark:bg-emerald-500/55",
  "bg-amber-400",
  "bg-orange-500",
  "bg-red-500",
]

/** The figure's ink: a step's colour, dark enough to read as text. */
const INK = [
  "text-muted-foreground",
  "text-foreground",
  "text-foreground",
  "text-amber-700 dark:text-amber-400",
  "text-orange-700 dark:text-orange-400",
  "text-red-700 dark:text-red-400",
]

/**
 * Three probes side by side where the card is wide enough for twenty blocks
 * each, and stacked otherwise. At the 300-odd pixels a four-column grid gives a
 * card, a third of the width is 6 px a block: too fine to see a two-block run of
 * congestion in, which is the whole point. So the usual case is three rows.
 */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 @[340px]:grid-cols-2",
  3: "grid-cols-1 @[480px]:grid-cols-3",
}

function slotTitle(slot: Slot, clock: (ms: number) => string) {
  if (!slot) return "无采样"
  const at = clock(slot.ts * 1000)
  if (slot.latency === null) return `${at} · 超时`
  return `${at} · ${fmtMs(slot.latency)} ms · 丢包 ${fmtLoss(slot.loss)}%`
}

/** Twenty blocks, one per three minutes of the last hour. */
function Strip({ slots, typical, clock, className }: {
  slots: Slot[]
  typical: number | null
  clock: (ms: number) => string
  className?: string
}) {
  return (
    // The figures above carry the reading; the strip is the same data drawn, so
    // a screen reader is spared twenty unlabelled boxes.
    <div className={cn("grid grid-cols-20 gap-0.5", className)} aria-hidden>
      {slots.map((slot, i) => (
        <span
          key={i}
          title={slotTitle(slot, clock)}
          className={cn("h-2.5 rounded-xs", FILL[slotSignal(slot, typical)])}
        />
      ))}
    </div>
  )
}

function Probe({ probe, hours }: { probe: ProbeStats; hours: number }) {
  const clock = clockFor(hours)
  return (
    <div className="min-w-0" title={`${probe.name} · 近 ${hours} 小时的延迟与丢包`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{probe.name}</span>
        <span className="tnum flex shrink-0 items-baseline gap-1">
          <span className={cn("font-medium", INK[probeLatencySignal(probe)])}>
            {probe.latest !== null ? `${fmtMs(probe.latest)} ms` : probe.timedOut ? "超时" : "—"}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
            {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
          </span>
        </span>
      </div>
      <Strip slots={probe.slots} typical={probe.typical} clock={clock} className="mt-1.5" />
    </div>
  )
}

/**
 * The bottom of a node card: one row per probe, the newest latency and the
 * hour's loss beside a strip of the hour itself.
 *
 * A card below the fold asks nothing until it is nearly in view. A hundred nodes
 * would otherwise queue a hundred history queries on load, two at a time, and the
 * three cards someone is looking at would wait behind all of them.
 */
export function PingPanel({ node, hours = HOURS }: { node: Node; hours?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setSeen(true)
        observer.disconnect()
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])

  const entry = useNodePing(node.id, hours, seen)
  // Recomputed on each render rather than memoised: the strip is twenty blocks
  // off at most sixty rows, and the window is aligned to the block grid, so a
  // push every two seconds produces the same blocks until a block rolls over.
  const probes = entry?.data ? cardProbes(entry.data) : []

  return (
    <div ref={ref} className="@container mt-3 border-t pt-3">
      {probes.length ? (
        <div className={cn("grid gap-x-4 gap-y-3", COLUMNS[probes.length])}>
          {probes.map((probe) => <Probe key={probe.id} probe={probe} hours={hours} />)}
        </div>
      ) : !entry ? (
        // The design case while the first answer is on its way, so the card does
        // not jump when it lands. Nodes with fewer probes shrink by a row or two.
        <div className={cn("grid gap-x-4 gap-y-3", COLUMNS[3])} aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <div className="flex justify-between gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="mt-1.5 h-2.5 w-full" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
