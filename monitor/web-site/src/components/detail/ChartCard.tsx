import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { cn } from "@/lib/utils"

const TONES = {
  cpu: "bg-rose-500/10 text-rose-600 ring-rose-500/20 dark:text-rose-400",
  mem: "bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-400",
  disk: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400",
  net: "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-400",
  conns: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400",
  proc: "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300",
  latency: "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-400",
  quality: "bg-teal-500/10 text-teal-600 ring-teal-500/20 dark:text-teal-400",
} as const

export type ChartTone = keyof typeof TONES

/**
 * The icon tile a card's heading opens with: one glyph, one tint, the same box on
 * every card of the page.
 *
 * Exported because the latency and quality cards are not `ChartCard`s -- one
 * carries a chip where the other has a note, and both have controls a fixed
 * layout cannot place -- but a page where four charts open with an icon tile and
 * the two below them open with bare text reads as two different pages.
 */
export function IconTile({ icon: Icon, tone }: { icon: LucideIcon; tone: ChartTone }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", TONES[tone])}>
      <Glyph icon={Icon} box="md" />
    </span>
  )
}

/**
 * A load chart in its card. The icon tile is the one per-chart colour cue other
 * than the lines; the note on the right is the live figure, not the window's
 * mean, because the node prop behind it updates every two seconds.
 */
export function ChartCard({ icon: Icon, tone, title, subtitle, note, legend, empty, className, children }: {
  icon: LucideIcon
  tone: ChartTone
  title: string
  subtitle?: ReactNode
  note?: ReactNode
  legend?: ReactNode
  /**
   * Shown instead of the plot when the panel has nothing to draw -- every series
   * switched off through its legend. A pair of axes with no line in it reads as
   * "no data", which is a different and false statement.
   */
  empty?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <Card className={cn("@container min-w-0 gap-0 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <IconTile icon={Icon} tone={tone} />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold sm:text-base" title={title}>{title}</h3>
            {subtitle != null && (
              <p className="hidden truncate text-3xs text-muted-foreground @[18rem]:block">{subtitle}</p>
            )}
          </div>
        </div>
        {note != null && <div className="shrink-0 text-right text-xs text-muted-foreground">{note}</div>}
      </div>
      {/* The plot gets 192px, 224px past xl: a longer aspect than 160px gave,
          and enough to keep a 30-day line from reading as a texture. A sentence
          takes the same box, so switching a series off does not move the cards
          below it. */}
      {empty != null ? (
        <div className="mt-2 grid h-48 w-full place-items-center text-sm text-muted-foreground xl:h-56">{empty}</div>
      ) : (
        <div className="mt-2 h-48 w-full text-muted-foreground xl:h-56" role="img" aria-label={`${title} 曲线`}>
          {children}
        </div>
      )}
      {legend != null && <div className="mt-2">{legend}</div>}
    </Card>
  )
}
