import { Money } from "@/components/Money"
import type { Node } from "@/lib/api"
import { cycleSuffix, daysUntil, moneyMark, moneyParts } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Whole days left, or null where nothing expires. */
export function expiryDays(node: Node): number | null {
  return node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
}

/**
 * The price in the pieces a tag draws it in: the mark (`US$`, `¥`, `£`), the
 * amount, and the period as a suffix to hang off it.
 *
 * The one formatting decision lives here, so the card's footer and the detail
 * page's spec cell print the same fact the same way: cents only where there are
 * cents (`$168`, not `$168.00`), and no suffix for a one-off purchase, which has
 * a date rather than a period. A machine with no price is `免费` in the value,
 * with nothing else on the line.
 */
export function priceParts(node: Node): { mark: string; value: string; suffix: string | null } {
  if (!(node.price > 0)) return { mark: "", value: "免费", suffix: null }
  const { value } = moneyParts(node.price, node.currency, node.price % 1 === 0 ? 0 : 2)
  return { mark: moneyMark(node.currency), value, suffix: cycleSuffix(node.billing_cycle) }
}

/**
 * The last line of a card: what it costs per period and what that period buys,
 * laid out the way a price tag is -- `$168/3年 · 剩 981 天`.
 *
 * The period rides on the price as a suffix rather than standing in front of it
 * as a word. `年付 $168` spends the start of the line on a label the reader
 * wants after the figure, and it left the footer with two blocks at opposite
 * corners for one thought; `$168/3年` is one token, and the count after it is
 * the only other thing on the line.
 *
 * The three edges of the data are the three edges of this line: a machine with
 * no price is `免费`, one with no end date is `永久`, and one that lapsed says
 * so in the state colour instead of a negative count. `免费 · 永久` is a real
 * card on a small fleet, not a fallback.
 *
 * Both densities use it and only the type size differs: a footer is the same
 * sentence in a card and in a row.
 *
 * The price is set a size above the rest of the line. Ten pixels was small
 * enough that the mark -- drawn a step down and a shade lighter -- could not be
 * read at all; at fourteen and sixteen the two read as a unit and a number, and
 * the count beside them stays where it was.
 */
export function Billing({ node, className, size = "sm" }: {
  node: Node
  className?: string
  /** On a card the price may be drawn a step up from the same line in a row. */
  size?: "sm" | "md"
}) {
  const days = expiryDays(node)
  const { mark, value, suffix } = priceParts(node)
  const expired = days !== null && days < 0
  const tone = expired ? "text-destructive" : days !== null && days <= 7 ? "text-warn" : "text-muted-foreground"

  return (
    // `justify-end`: the price is right-aligned against the card's edge, which
    // is where a price is looked for and where the two densities line up.
    <div className={cn("tnum flex items-baseline justify-end gap-1.5 whitespace-nowrap", className)}>
      <Money
        mark={mark}
        value={value}
        suffix={suffix}
        className={cn("font-semibold text-foreground", size === "md" ? "text-base" : "text-sm")}
      />
      <span aria-hidden className="text-xs text-border">·</span>
      <span className={cn("text-xs", tone)} title={node.expires_at ?? undefined}>
        {days === null ? "永久" : expired ? `已过期 ${-days} 天` : `剩 ${days} 天`}
      </span>
    </div>
  )
}
