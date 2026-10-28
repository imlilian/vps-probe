import type { LucideIcon } from "lucide-react"

import { Glyph } from "@/components/ui/glyph"
import { cn } from "@/lib/utils"

export type MetricTone = "ok" | "warn" | "danger" | "muted"

const TONE: Record<MetricTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-destructive",
  muted: "text-muted-foreground",
}

/**
 * One figure of the machine at rest: label and an icon on the first line, the
 * number and its unit on the second.
 *
 * The tile is a well rather than a card: sixteen raised cards would compete
 * with the four information cards below and the six charts after them. It sits
 * on `card-2`, gains a surface only under the pointer, and carries no border --
 * the spacing between the tiles is what separates them.
 */
export function MetricTile({ icon: Icon, label, value, unit, title, tone, valueClass }: {
  icon: LucideIcon
  label: string
  /** The figure; unit is separate so `30 天 10 小时` and `/ 月` are not split by accident. */
  value: string
  unit?: string
  title?: string
  tone?: MetricTone
  /** The uptime line needs a smaller size; everything else keeps the figure scale. */
  valueClass?: string
}) {
  return (
    <div
      title={title}
      className="group flex min-h-20 min-w-0 flex-col justify-between rounded-xl bg-card-2 p-3.5 transition-colors hover:bg-card hover:shadow-card"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="truncate text-xs font-medium tracking-wide text-muted-foreground">{label}</span>
        <Glyph
          icon={Icon}
          box="lg"
          className="text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
        />
      </div>
      <div className={cn("mt-3 flex min-w-0 items-baseline gap-1", tone && TONE[tone])}>
        <span className={cn("text-base leading-none font-semibold tnum break-keep sm:text-2xl", valueClass)}>{value}</span>
        {unit && <span className="shrink-0 text-2xs font-normal text-muted-foreground">{unit}</span>}
      </div>
    </div>
  )
}
