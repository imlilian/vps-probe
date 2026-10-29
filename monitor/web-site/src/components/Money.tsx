import { cn } from "@/lib/utils"

/**
 * An amount with its currency: the mark a size down and a shade lighter, the
 * figure at whatever size its container sets, and the period it buys trailing as
 * small as the mark.
 *
 * The split exists because a price has two voices. `¥29.90/月` in one weight and
 * one colour reads as a label; the same characters with the mark as a unit --
 * smaller, grey, held off by a space -- read as a figure, which is what the
 * card, the tile and the estimate are all trying to say. It also pays for the
 * prefixes `moneyMark` keeps on everything but the dollar and the yuan: `JP¥` and
 * `HK$` are what keep `¥` and `$` from being read as the other currency on the
 * next card, and at `0.7em` in muted ink they cost about what the bare symbol
 * did.
 *
 * The type size is the caller's, passed as a class: `em` makes the mark and the
 * period follow it, so one component serves a 10px footer, a 24px tile and the
 * estimate on the summary card. The weight is the caller's too, since a tile
 * sets semibold where the summary's figure is already bold.
 */
export function Money({ mark, value, suffix, className }: {
  /** From `moneyMark`; empty when the amount is not a price at all (`免费`). */
  mark?: string
  /** From `moneyParts`: the figure, grouped and rounded as the locale writes it. */
  value: string
  /** From `cycleSuffix`: the period the price buys, without its slash. */
  suffix?: string | null
  className?: string
}) {
  return (
    <span className={cn("tnum inline-flex items-baseline whitespace-nowrap", className)}>
      {/* A space rather than a margin: it keeps the mark on the text baseline
          and disappears when there is no mark to hold off. */}
      {mark && (
        <span className="mr-1 text-[0.7em] font-medium text-muted-foreground">{mark}</span>
      )}
      <span>{value}</span>
      {suffix && <span className="ml-0.5 text-[0.7em] font-medium text-muted-foreground">/{suffix}</span>}
    </span>
  )
}
