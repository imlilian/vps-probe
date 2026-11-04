import * as React from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * A pill that is either on or off.
 *
 * The list's group tabs, the detail page's ranges and its latency legend are one
 * control, and they are drawn once: a pressed chip is the brand tint at 10% with
 * its border at 40%, which is the same receipt the group tabs under the summary
 * give. Everything else about the two rows follows from saying yes or no.
 */
function Chip({ pressed, className, ...props }: React.ComponentProps<typeof Button> & { pressed: boolean }) {
  return (
    <Button
      aria-pressed={pressed}
      variant="ghost"
      className={cn(
        "h-7 shrink-0 rounded-md border px-2 text-2xs",
        pressed
          ? "border-brand/40 bg-brand/10 font-medium text-brand"
          : "border-transparent text-muted-foreground hover:bg-card hover:text-foreground",
        className,
      )}
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
 * the fill does. The track is the inset surface and the chosen stop is the
 * card's own, which is how the density pair at the top of the list is drawn.
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
      className={cn("flex h-8 shrink-0 items-center gap-0.5 rounded-lg border bg-card-2 p-0.5", className)}
    >
      {items.map((item) => (
        <Button
          key={item.value}
          aria-pressed={value === item.value}
          variant="ghost"
          className={cn(
            "h-7 rounded-md px-2.5 text-2xs",
            value === item.value
              ? "bg-selected text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </Button>
      ))}
    </div>
  )
}

export { Chip, Segmented }
