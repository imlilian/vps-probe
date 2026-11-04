import * as React from "react"

import { cn } from "@/lib/utils"

// The shell only. shadcn's card ships a header, title, description, action,
// content and footer alongside it; this theme lays out its cards itself, so all
// six were unused from the moment they were vendored. Restore one from upstream
// if a card ever needs it.
//
// The fill is translucent but no longer blurred: the page is a continuous wash
// rather than a dot grid, so there is nothing to soften, and an unblurred card
// keeps 12px chart hairlines crisp. The border is the softer token -- a card is
// a plane, not a box -- and the shadow is one shallow lift rather than the old
// contact line plus wide drop.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border border-border-soft bg-card py-6 text-card-foreground shadow-card",
        className
      )}
      {...props}
    />
  )
}

export { Card }
