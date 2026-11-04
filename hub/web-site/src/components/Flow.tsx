import { ArrowDown, ArrowUp } from "lucide-react"

import { Glyph } from "@/components/ui/glyph"
import { cn } from "@/lib/utils"

/**
 * The colours of the two directions a rate flows in. Emerald down and blue up,
 * written once: the card's traffic block, the compact card's speed line and the
 * summary's flow tiles all read a direction by these, and they must not drift
 * apart -- a reader comparing the three is comparing the same fact.
 */
export const flowTone = (down: boolean) =>
  down ? "text-emerald-600 dark:text-emerald-400" : "text-blue-600 dark:text-blue-400"

/**
 * The arrow and its two letters: the label half of a rate. RX/TX rather than
 * 入站/出站 -- two letters are the same width in every language, they are what
 * the labels on a switch port already say, and the arrow in front of them
 * carries the meaning for anyone who has never met the abbreviation.
 *
 * The figure beside it stays with the caller: its size and alignment are what
 * differ between the three places this label sits, and the number is not the
 * part that has to agree.
 */
export function FlowTag({ dir, className }: { dir: "rx" | "tx"; className?: string }) {
  const down = dir === "rx"
  return (
    <span className={cn("flex shrink-0 items-center gap-0.5 text-2xs font-semibold", flowTone(down), className)}>
      <Glyph icon={down ? ArrowDown : ArrowUp} box="sm" />
      {down ? "RX" : "TX"}
    </span>
  )
}
