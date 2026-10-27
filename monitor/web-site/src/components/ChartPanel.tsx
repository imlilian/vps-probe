import type { LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/**
 * One chart in its card: an icon in the hue of the figure it draws, the heading,
 * and the figure the chart is at right now.
 *
 * The figure is on the right, in `Figure`'s two weights -- number at full
 * weight, unit a step down -- because the node prop behind it updates every two
 * seconds: the card answers "and now?" without a trip to the last point of the
 * line, and it does so in the one place the eye already rests on this page.
 *
 * `foot` is for what does not fit the heading, such as the connection legend,
 * which is also its readout.
 *
 * min-w-0 on the card is load-bearing: a grid item refuses to shrink below its
 * content, recharts writes the measured width onto the <svg> as an attribute,
 * and that number then becomes the card's floor. On a phone the chart held the
 * card 47px wider than the column and the page scrolled sideways. `min-w-0` lets
 * the track win, and the container measures again.
 */

/**
 * The hue family each figure already wears on this page: the squares take the
 * same four families the resource bars in `Meter` do, so a disk is amber here
 * and in the bar above it, and the two panels without a bar of their own (a rate,
 * the sockets) take the hue of their own line. The tint is the hue at a fraction
 * of its strength, so the square reads as a label and not as data.
 */
const TONES = {
  cpu: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
  mem: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
  disk: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
  load: "bg-pink-500/12 text-pink-600 dark:text-pink-400",
  net: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  conns: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
} as const
export type ChartTone = keyof typeof TONES

/**
 * The tinted square a figure wears in front of its name. `toolbar` is the metric
 * row's size; the panel head uses the larger one.
 */
export function ToneIcon({ icon: Icon, tone, size = "sm" }: {
  icon: LucideIcon
  tone: ChartTone
  size?: "sm" | "md"
}) {
  return (
    <span className={cn("grid shrink-0 place-items-center rounded-md", size === "md" ? "size-6" : "size-5", TONES[tone])}>
      <Icon size={size === "md" ? 14 : 12} strokeWidth={2} aria-hidden />
    </span>
  )
}

export function ChartPanel({ icon: Icon, tone, title, subtitle, note, foot, className, children }: {
  icon: LucideIcon
  tone: ChartTone
  title: string
  /** What the title cannot carry: a window's peak, a machine's size. */
  subtitle?: React.ReactNode
  /** The live figure, right-aligned. A `Figure`, so the unit sits a step down. */
  note?: React.ReactNode
  foot?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    // `@container`: the subtitle is dropped on a narrow card, not clipped. A
    // 360px phone leaves the head 284px, and "峰值 ↓ 41.5 MB/s · ↑ 60.6 MB/s"
    // had been squeezed down to "峰…" -- an ellipsis that names nothing. The
    // live figure on the right is what that reader came for; the window's peak
    // appears once the card is wide enough to hold it (436px at a 500px page).
    <Card className={cn("@container min-w-0 gap-0 p-4", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <ToneIcon icon={Icon} tone={tone} size="md" />
          <h3 className="shrink-0 truncate text-xs font-medium text-muted-foreground" title={title}>{title}</h3>
          {subtitle != null && (
            <span className="hidden min-w-0 truncate text-2xs text-muted-foreground @[20rem]:block">{subtitle}</span>
          )}
        </div>
        {note != null && <span className="shrink-0 text-right text-xs">{note}</span>}
      </div>
      {/* 208px at every width, 224 past `xl`: the plot wants a longer aspect
          ratio than 40px of height gave it, and the extra row of pixels is what
          keeps a 24h line from reading as a texture at the two-column grid. */}
      <div className="mt-2 h-52 w-full text-muted-foreground xl:h-56">{children}</div>
      {foot != null && <div className="mt-3">{foot}</div>}
    </Card>
  )
}

/**
 * The area under a line, fading downward: strong where it meets the line and
 * nearly gone at the base, instead of one flat wash.
 *
 * The flat 15% fill made every area panel a rectangle of colour with a line on
 * top; a gradient keeps the reading ("how much of the window was spent here")
 * and lets the grid through at the bottom, which is where the eye has least to
 * read. Same hue as the stroke, so the two are one object.
 *
 * `id` has to be unique per chart: an SVG fragment resolves to the first match
 * in the document, and five panels sharing "fade" would all take CPU's.
 */
export function ChartFade({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.26} />
        <stop offset="100%" stopColor={color} stopOpacity={0.02} />
      </linearGradient>
    </defs>
  )
}

/**
 * The grid and the crosshair, in one place so the five panels agree: 2 4 dashes
 * at the hairline token rather than recharts' 3 3 at the border token, which at
 * this density read as a second data set.
 */
export const GRID = { strokeDasharray: "2 4", className: "stroke-border-soft", vertical: false } as const
export const CURSOR = { stroke: "var(--border)", strokeDasharray: "3 3" } as const
