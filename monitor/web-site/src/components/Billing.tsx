import type { Node } from "@/lib/api"
import { cycleSuffix, daysUntil, moneyMark, moneyParts } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Whole days left, or null where nothing expires. */
export function expiryDays(node: Node): number | null {
  return node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
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
 */
export function Billing({ node, className }: { node: Node; className?: string }) {
  const days = expiryDays(node)
  const priced = node.price > 0
  // Cents only where there are cents: a tag reads `$168/3年`, not `$168.00/3年`,
  // and `¥29.90` keeps both digits because it has them.
  const { value } = moneyParts(node.price, node.currency, node.price % 1 === 0 ? 0 : 2)
  const suffix = priced ? cycleSuffix(node.billing_cycle) : null
  const expired = days !== null && days < 0
  const tone = expired ? "text-destructive" : days !== null && days <= 7 ? "text-warn" : "text-muted-foreground"

  return (
    // `justify-end`: the price is right-aligned against the card's edge, which
    // is where a price is looked for and where the two densities line up.
    <div className={cn("tnum flex items-baseline justify-end gap-1.5 whitespace-nowrap", className)}>
      <span className="font-semibold text-foreground">
        {priced ? (
          <>
            {moneyMark(node.currency)}
            {value}
            {suffix && <span className="font-medium text-muted-foreground">/{suffix}</span>}
          </>
        ) : (
          "免费"
        )}
      </span>
      <span aria-hidden className="text-border">·</span>
      <span className={tone} title={node.expires_at ?? undefined}>
        {days === null ? "永久" : expired ? `已过期 ${-days} 天` : `剩 ${days} 天`}
      </span>
    </div>
  )
}
