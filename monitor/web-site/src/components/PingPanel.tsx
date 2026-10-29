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
 * Six fills: no data, then the five steps. Tailwind palette steps rather than
 * literal colours -- the block is a fill, so it needs 3:1 against the card and
 * nothing more, while the figure beside it is text and takes a darker step of the
 * same hue (see [INK]).
 *
 * The ramp is emerald, green, lime, yellow, rose, and it climbs in hue as well as
 * in lightness so that a run of slow blocks is visibly a run rather than a
 * slightly different green. Only the last step is red: it means the line lost
 * most of a block, which is the one thing worth stopping on.
 */
const FILL = [
  "bg-muted",
  "bg-signal-1",
  "bg-signal-2",
  "bg-signal-3",
  "bg-signal-4",
  "bg-signal-5",
]

/**
 * The figure's ink. The two greens share a step of ink -- lime at 11px is a
 * highlight, not text -- so the words beside a strip read as a value and not as a
 * palette sample.
 */
const INK = [
  "text-muted-foreground",
  "text-emerald-700 dark:text-emerald-400",
  "text-emerald-700 dark:text-emerald-400",
  "text-amber-700 dark:text-amber-400",
  "text-orange-700 dark:text-orange-400",
  "text-red-700 dark:text-red-400",
]

function slotTitle(slot: Slot, clock: (ms: number) => string) {
  if (!slot) return "无采样"
  const at = clock(slot.ts * 1000)
  if (slot.latency === null) return `${at} · 超时`
  return `${at} · ${fmtMs(slot.latency)} ms · 丢包 ${fmtLoss(slot.loss)}%`
}

/** Twenty blocks, one per three minutes of the last hour. */
function Strip({ slots, clock, className }: { slots: Slot[]; clock: (ms: number) => string; className?: string }) {
  return (
    // The figures above carry the reading; the strip is the same data drawn, so
    // a screen reader is spared twenty unlabelled boxes. The title on each block
    // is still there for a pointer, which is the only way to ask a block what it
    // was.
    <div className={cn("grid grid-cols-20 gap-0.5", className)} aria-hidden>
      {slots.map((slot, i) => (
        <span key={i} title={slotTitle(slot, clock)} className={cn("h-1.5 rounded-xs", FILL[slotSignal(slot)])} />
      ))}
    </div>
  )
}

/**
 * One probe: the name, the reading of the last few minutes, the hour's loss, and
 * the hour drawn under them.
 *
 * The figure is a window's median rather than the newest sample -- see [RECENT]
 * in `lib/ping.ts` for why one lost packet must not turn the card into a
 * timeout.
 *
 * Three columns of these was the alternative -- the reference theme draws them
 * side by side -- and it does not survive this card's width: a third of 300px is
 * ten pixels a block, which shows a colour but never a run of them. Stacked, each
 * strip is as wide as the card and a bad quarter of an hour is a shape.
 */
function Probe({ probe, hours }: { probe: ProbeStats; hours: number }) {
  const clock = clockFor(hours)
  const latency = probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} ms` : "—"
  return (
    <div className="py-1.5 first:pt-0 last:pb-0" title={`${probe.name} · 近 ${hours} 小时的延迟与丢包`}>
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate text-muted-foreground">{probe.name}</span>
        <span className="tnum flex shrink-0 items-baseline gap-1.5">
          <span className={cn("font-semibold", INK[probeLatencySignal(probe)])}>{latency}</span>
          <span aria-hidden className="text-border">·</span>
          <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
            {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
          </span>
        </span>
      </div>
      <Strip slots={probe.slots} clock={clock} className="mt-1" />
    </div>
  )
}

/**
 * A node's probe history, once its element is nearly in view.
 *
 * A page below the fold asks nothing until it is nearly on screen. A hundred
 * nodes would otherwise queue a hundred history queries on load, two at a time,
 * and the three cards someone is looking at would wait behind all of them.
 */
function useLazyPing(node: Node, hours: number) {
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

  return [ref, useNodePing(node.id, hours, seen)] as const
}

/**
 * The same hour for the compact card, as figures.
 *
 * No strip: at the 60-odd pixels a fourth of a compact card gives it, twenty
 * blocks are six pixels each, which shows a colour but never a run -- and a run
 * is the only thing a strip is better at than a number. Which probe and how bad
 * is one press away on the node's own page.
 */
export function ProbeLines({ node, hours = HOURS }: { node: Node; hours?: number }) {
  const [ref, entry] = useLazyPing(node, hours)
  const probes = entry?.data ? cardProbes(entry.data) : []
  if (entry && !probes.length) return null

  return (
    <div ref={ref} className="mt-1.5 space-y-0.5">
      {probes.length ? (
        probes.map((probe) => (
          <div key={probe.id} className="flex items-baseline justify-between gap-2 text-2xs" title={probe.name}>
            <span className="truncate text-muted-foreground">{probe.name}</span>
            <span className="tnum flex shrink-0 items-baseline gap-1.5">
              <span className={cn("font-semibold", INK[probeLatencySignal(probe)])}>
                {probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} ms` : "—"}
              </span>
              <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
                {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
              </span>
            </span>
          </div>
        ))
      ) : (
        <Skeleton aria-hidden className="h-3 w-full" />
      )}
    </div>
  )
}

/**
 * The bottom of a node card: the probes, one row each, inside the second of the
 * card's two wells.
 */
export function PingPanel({ node, hours = HOURS }: { node: Node; hours?: number }) {
  const [ref, entry] = useLazyPing(node, hours)
  // Recomputed on each render rather than memoised: the strip is twenty blocks
  // off at most sixty rows, and the window is aligned to the block grid, so a
  // push every two seconds produces the same blocks until a block rolls over.
  const probes = entry?.data ? cardProbes(entry.data) : []

  // Answered, and there is nothing to draw: the node has no probe configured.
  // The well goes with it -- a bordered box with 20px of nothing under it was the
  // bottom of every card on a fresh install. The frame belongs to the strips
  // inside, not to the absence of them.
  if (entry && !probes.length) return null

  return (
    <div ref={ref} className="mt-2.5 rounded-lg border border-border-soft bg-card-2 px-2.5 py-2">
      {probes.length ? (
        <div className="divide-y divide-border-soft">
          {probes.map((probe) => <Probe key={probe.id} probe={probe} hours={hours} />)}
        </div>
      ) : (
        // One row, not three. A placeholder that reserves the widest case and
        // then collapses on the answer pulls every card below it upward, which
        // is the jump it was meant to prevent; one row that grows pushes them
        // down instead, which reads as the content arriving rather than leaving.
        <div aria-hidden>
          <div className="flex justify-between gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="mt-1.5 h-1.5 w-full" />
        </div>
      )}
    </div>
  )
}
