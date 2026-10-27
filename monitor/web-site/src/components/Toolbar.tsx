import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Chip, Segmented } from "@/components/ui/chip"
import { Glyph } from "@/components/ui/glyph"
import { groupsOf, type Node } from "@/lib/api"
import { nextOrder, SORTS, sortFor, type Density, type Order, type SortKey } from "@/lib/sort"

type Props = {
  /** Every node, for the counts on the chips -- the rows below are already filtered. */
  nodes: Node[]
  /** How many the group filter left. */
  shown: number
  /** null is every node, "" the ungrouped. */
  group: string | null
  onGroup: (group: string | null) => void
  order: Order
  onOrder: (order: Order) => void
  density: Density
  onDensity: (density: Density) => void
}

const DENSITIES: { value: Density; label: string }[] = [
  { value: "standard", label: "标准" },
  { value: "compact", label: "紧凑" },
]

/**
 * The controls over the list: which group, in what order, at what size.
 *
 * Grouping is the only filter. A row of country flags was in the plan, and it
 * does not survive a phone: eight regions is eight more chips on a line that
 * already scrolls, and hiding the other machines answers a question nobody asked
 * -- what a visitor wants of a region is its machines together, which is the 地区
 * sort. Searching by name is left out for the same reason: the browser already
 * does it, and the count beside these controls says whether anything is hidden.
 *
 * Nothing here is a `<div onClick>`. The chips and the density pair are buttons
 * carrying `aria-pressed`, the order is a native `<select>`, and the arrow beside
 * it is a button whose label says which way it points and what a press will do.
 * `aria-sort` is not used: it is legal only on a table's header cell, and the
 * state it describes is already in the select's value and the arrow's label.
 */
export function Toolbar({ nodes, shown, group, onGroup, order, onOrder, density, onDensity }: Props) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  const tabs = [
    [null, "全部", nodes.length] as const,
    ...groups.map((g) => [g, g, nodes.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
  const hint = sortFor(order.key).hint
  const direction = order.dir === "asc" ? "升序" : "降序"

  return (
    <div className="space-y-2">
      {/* Group names are free text, so they carry a prefix no key of the 全部 tab
          can share. The row scrolls rather than wraps: twelve groups wrapped into
          four lines push the fleet off a phone's screen. */}
      {groups.length > 0 && (
        <div role="group" aria-label="分组" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {tabs.map(([value, label, count]) => (
            <Chip
              key={value === null ? "*" : `=${value}`}
              pressed={group === value}
              onClick={() => onGroup(value)}
            >
              {label}
              <span className="tnum text-muted-foreground">{count}</span>
            </Chip>
          ))}
        </div>
      )}

      {/* Wraps rather than scrolls, so a 360px phone gets a second line instead of
          a control that has slid out of reach. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <div className="flex h-8 items-center rounded-md border bg-card">
          <div className="relative flex items-center">
            <select
              aria-label="排序"
              title={hint}
              value={order.key}
              onChange={(e) => onOrder(nextOrder(order, e.target.value as SortKey))}
              className="h-8 cursor-pointer appearance-none rounded-md bg-transparent pr-7 pl-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {SORTS.map((sort) => (
                <option key={sort.key} value={sort.key}>{sort.label}</option>
              ))}
            </select>
            <Glyph icon={ChevronDown} box="sm" className="pointer-events-none absolute right-1.5 text-muted-foreground" />
          </div>
          <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          {/* The arrow is the receipt for the press: it points the way the list
              runs, so a reversed list is visible without reading an option. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-sm"
            aria-label={`${hint}，${direction}；按下改为${order.dir === "asc" ? "降序" : "升序"}`}
            title={`${hint}（${direction}）`}
            onClick={() => onOrder(nextOrder(order, order.key))}
          >
            <Glyph icon={order.dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow} box="sm" />
          </Button>
        </div>

        <Segmented
          label="卡片密度"
          value={density}
          items={DENSITIES}
          onChange={onDensity}
        />

        <span className="tnum ml-auto shrink-0 text-xs text-muted-foreground">{`${shown} / 共 ${nodes.length} 台`}</span>
      </div>
    </div>
  )
}
