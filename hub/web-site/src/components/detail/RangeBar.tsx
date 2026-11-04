import type { ReactNode } from "react"

import { Chip } from "@/components/ui/chip"

/**
 * The load section's range row: the time buckets on the left, centered like the
 * reference, and whatever belongs to the section on the right (the 削峰 chip).
 *
 * On a phone the chips *wrap* to a second row rather than scrolling sideways.
 * The reference scrolls, and a strip of chips is the one thing most pages do
 * that way -- but a scroller hides whole ranges off the right edge with nothing
 * to say so, and at 360px these five chips need two short rows, not three. The
 * overflow container stays for the case where a hub keeps a year of history.
 */
export function RangeBar({ ranges, value, onChange, right, allowLive = true }: {
  ranges: { hours: number; label: string }[]
  value: "live" | number
  onChange: (value: "live" | number) => void
  right?: ReactNode
  /** The load section offers realtime; the latency section starts at one hour. */
  allowLive?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
      <div className="min-w-0 flex-1 overflow-x-auto">
        <div role="group" aria-label="时间范围" className="flex w-max min-w-full flex-wrap items-center justify-center gap-1">
          {allowLive && <Chip pressed={value === "live"} onClick={() => onChange("live")}>实时</Chip>}
          {ranges.map((range) => (
            <Chip key={range.hours} pressed={value === range.hours} onClick={() => onChange(range.hours)}>
              {range.label}
            </Chip>
          ))}
        </div>
      </div>
      {right}
    </div>
  )
}
