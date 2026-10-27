import type { ReactNode } from "react"

type Props = { label: ReactNode; pct: number | null; foot: ReactNode; empty?: ReactNode }

/**
 * A percentage at the precision a bar has room for: one decimal below ten (a
 * machine at 4% is not the same as one at 0%), whole numbers above it. `null`
 * means there is no ceiling to measure against, and what replaces it depends on
 * the reason -- unknown for a node with no metrics, `∞` for a plan with no limit.
 */
export function percentText(pct: number | null, empty: ReactNode = "—"): ReactNode {
  return pct === null ? empty : `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`
}

/**
 * One metric: name and percentage on top, bar in the middle, raw numbers
 * underneath. Monochrome, since the length of the bar carries the message.
 */
export function Meter({ label, pct, foot, empty = "—" }: Props) {
  // null means the metric has no ceiling to fill, so the bar stays empty rather
  // than reporting 0%. The bar stops at full while the figure does not, so a
  // plan past its quota reads 209%.
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="tnum text-xs font-medium">{percentText(pct, empty)}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${filled}%` }} />
      </div>
      <div className="tnum mt-1.5 truncate text-xs text-muted-foreground">{foot}</div>
    </div>
  )
}
