import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { cn } from "@/lib/utils"

const TONES = {
  cpu: "bg-rose-500/10 text-rose-600 ring-rose-500/20 dark:text-rose-400",
  mem: "bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-400",
  disk: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400",
  load: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400",
  net: "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-400",
  conns: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400",
  proc: "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300",
} as const

export type ChartTone = keyof typeof TONES

/**
 * A load chart in its card. The icon tile is the one per-chart colour cue other
 * than the lines; the note on the right is the live figure, not the window's
 * mean, because the node prop behind it updates every two seconds.
 */
export function ChartCard({ icon: Icon, tone, title, subtitle, note, legend, className, children }: {
  icon: LucideIcon
  tone: ChartTone
  title: string
  subtitle?: ReactNode
  note?: ReactNode
  legend?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <Card className={cn("@container min-w-0 gap-0 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", TONES[tone])}>
            <Glyph icon={Icon} box="md" />
          </span>
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
          and enough to keep a 30-day line from reading as a texture. */}
      <div className="mt-2 h-48 w-full text-muted-foreground xl:h-56">{children}</div>
      {legend != null && <div className="mt-2">{legend}</div>}
    </Card>
  )
}
