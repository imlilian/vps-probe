import * as React from "react"

import { cn } from "@/lib/utils"

// The shell only. shadcn's card ships a header, title, description, action,
// content and footer alongside it; this theme lays out its cards itself, so all
// six were unused from the moment they were vendored. Restore one from upstream
// if a card ever needs it.
//
// The fill is translucent and blurred: the page's dot grid showing through at
// 12px is what makes a grid of cards read as one surface, and it costs nothing
// at rest since the layer underneath never moves. The shadow is the stock one --
// on a pale page the edge is drawn by the border, not by a deeper drop.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm backdrop-blur-md",
        className
      )}
      {...props}
    />
  )
}

export { Card }
