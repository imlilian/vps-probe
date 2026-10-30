import type { CSSProperties } from "react"

import { fmtLoss, fmtMs, qualitySignal, type Quality, type Slot } from "@/lib/ping"
import { cn } from "@/lib/utils"

/**
 * The quality strip's fills: what went wrong in a block, or nothing.
 *
 * Deliberately not the latency ramp. That one is a continuous scale where every
 * block is coloured and the colour says how far away the target was; this one
 * marks exceptions, because "clean" is the state almost every block is in and a
 * second full ladder beside the first would compete with it. A clean block is a
 * third of the way to the best green -- present, so the strip reads as blocks
 * rather than as gaps, and quiet enough to be skipped by the eye.
 */
export const QUALITY_FILL: Record<Quality, string> = {
  none: "bg-muted",
  clean: "bg-signal-1/35",
  retx: "bg-signal-4",
  lost: "bg-signal-5",
}

/** What each fill means, in the order the legend reads. */
export const QUALITY_LEGEND: { quality: Quality; label: string }[] = [
  { quality: "clean", label: "干净" },
  { quality: "retx", label: "重传" },
  { quality: "lost", label: "丢包" },
  { quality: "none", label: "无采样" },
]

export const qualityFill = (slot: Slot) => QUALITY_FILL[qualitySignal(slot)]

/** A block's tooltip: when it was, and the two figures behind its colour. */
export function slotTitle(slot: Slot, clock: (ms: number) => string) {
  if (!slot) return "无采样"
  const at = clock(slot.ts * 1000)
  if (slot.latency === null) return `${at} · 超时`
  return `${at} · ${fmtMs(slot.latency)} ms · 丢包 ${fmtLoss(slot.loss)}% · 重传 ${fmtLoss(slot.retx)}%`
}

/**
 * A row of blocks: one per lane of time, four pixels tall, coloured by whatever
 * the caller measures.
 *
 * Shared by the card's two strips and the detail page's quality card, which is
 * the point -- a block means the same thing wherever it appears. The count is
 * the caller's: the card's twenty are fixed at three minutes each, and the
 * detail card picks both from its window (`qualityBlocks` in `lib/ping.ts`).
 *
 * The figures above carry the reading; this is the same data drawn, so a screen
 * reader is spared a row of unlabelled boxes. The title on each block is still
 * there for a pointer, which is the only way to ask a block what it was.
 */
export function SignalStrip({
  slots, clock, fill, className, style,
}: {
  slots: Slot[]
  clock: (ms: number) => string
  fill: (slot: Slot) => string
  /** The column template as a class, where it is fixed (`grid-cols-20`). */
  className?: string
  /** Or as a template, where the count follows the window. */
  style?: CSSProperties
}) {
  return (
    <div className={cn("grid gap-px", className)} style={style} aria-hidden>
      {slots.map((slot, i) => (
        <span key={i} title={slotTitle(slot, clock)} className={cn("h-1 rounded-xs", fill(slot))} />
      ))}
    </div>
  )
}
