import type { LucideIcon, LucideProps } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The one icon library, and the one drawing weight.
 *
 * Every line glyph here comes from Lucide -- the set shadcn's own components
 * draw with, so a tile header, a table row and a button look drawn by one hand:
 * the same 24px grid, the same 2-unit stroke, the same round caps. Two other
 * families sit beside it, and neither is an alternative to it: the distribution
 * marks in a node card are simple-icons, filled brand paths nobody's line set
 * carries, and the detail page's legend swatch is a sample of a chart line,
 * drawn to match the line rather than to say anything.
 *
 * The boxes are three, and there is no fourth, because Lucide scales its stroke
 * with the box: a 12px glyph draws its stroke at 1px and turns to grey mush
 * beside 12px text, which is why everything below 14px was soft. 14px lands the
 * stroke at 1.17px and 16px at 1.33px; those are the two sizes a page actually
 * needs, and 20px is for a glyph standing on its own.
 */
const BOX = {
  sm: "size-3.5", // 14px: inside a line of text, beside a 12-14px figure
  md: "size-4", // 16px: the default -- a tile or card header, a toolbar
  lg: "size-5", // 20px: on its own
} as const

type Props = Omit<LucideProps, "size"> & {
  icon: LucideIcon
  box?: keyof typeof BOX
}

export function Glyph({ icon: Shape, box = "md", className, ...rest }: Props) {
  // Decorative: the word beside an icon is always the thing that carries the
  // meaning, and a screen reader reading "server" before "节点" says it twice.
  return <Shape aria-hidden className={cn(BOX[box], "shrink-0", className)} {...rest} />
}
