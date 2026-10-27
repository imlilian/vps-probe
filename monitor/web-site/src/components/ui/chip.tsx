import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * A pill that is either on or off.
 *
 * The list's group tabs, the detail page's ranges and its latency legend are one
 * control: `aria-pressed` carries the state for a screen reader, and the fill is
 * the receipt for everyone else -- a chip pressed into the secondary surface
 * reads as selected without a second colour entering the page. The label is set
 * a step down and muted when idle, so a row of them reads as one control rather
 * than a row of buttons competing with the figures underneath.
 */
function Chip({ pressed, className, ...props }: React.ComponentProps<typeof Button> & { pressed: boolean }) {
  return (
    <Button
      aria-pressed={pressed}
      size="sm"
      variant={pressed ? "secondary" : "ghost"}
      className={cn("h-7 shrink-0 rounded-full px-2.5 text-xs", !pressed && "text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * Two or three chips welded into one control, for a choice that is one setting
 * rather than a set of tabs: the list's density, the detail page's two views.
 *
 * The box is what separates it from a row of chips beside it -- a segmented
 * control is a single value someone is picking, and the border says so before
 * the fill does.
 */
function Segmented<T extends string>({ label, value, onChange, items, className }: {
  /** Names the group: the chips themselves carry values, not roles. */
  label: string
  value: T
  onChange: (value: T) => void
  items: readonly { value: T; label: string }[]
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex h-8 shrink-0 items-center rounded-md border bg-card p-0.5", className)}
    >
      {items.map((item) => (
        <Button
          key={item.value}
          aria-pressed={value === item.value}
          size="sm"
          variant={value === item.value ? "secondary" : "ghost"}
          className="h-7 rounded-sm px-2 text-xs"
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}

export { Chip, Segmented }
