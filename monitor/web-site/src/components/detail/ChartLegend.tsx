import { cn } from "@/lib/utils"

export type LegendItem = { key: string; label: string; color: string; dash?: string }

/** One legend row, and the only place a chart's series are named on screen. */
export function ChartLegend({ items, hidden, onToggle, label }: {
  items: LegendItem[]
  hidden: string[]
  onToggle: (key: string) => void
  /** What the group describes, for a screen reader. */
  label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {items.map((item) => {
        const shown = !hidden.includes(item.key)
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={shown}
            onClick={() => onToggle(item.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-sm text-2xs transition-opacity",
              shown ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground opacity-40 hover:opacity-70",
            )}
          >
            <svg width="14" height="6" aria-hidden className="shrink-0">
              <line x1="0" y1="3" x2="14" y2="3" stroke={item.color} strokeDasharray={item.dash} strokeWidth="2" />
            </svg>
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
