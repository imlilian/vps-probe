import { useEffect, useRef, useState } from "react"
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, LayoutGrid, Rows3, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Glyph } from "@/components/ui/glyph"
import { groupsOf, type Node } from "@/lib/api"
import { nextOrder, SORTS, sortFor, type Density, type Order, type SortKey } from "@/lib/sort"
import { cn } from "@/lib/utils"

type Props = {
  /** Every node, for the total beside the density switch. */
  nodes: Node[]
  /**
   * The fleet as the search leaves it. The chips count these rather than the
   * fleet, so a tab can never advertise a machine the query has excluded: with
   * `香港` typed and one node in Tokyo, a chip reading `日本 1` is a tab that
   * opens on nothing. Equal to `nodes` when nothing is typed.
   */
  found: Node[]
  /** How many the group and the search left. */
  shown: number
  /** null is every node, "" the ungrouped. */
  group: string | null
  onGroup: (group: string | null) => void
  order: Order
  onOrder: (order: Order) => void
  density: Density
  onDensity: (density: Density) => void
  /** What the search box holds; the empty string searches nothing. */
  query: string
  onQuery: (query: string) => void
}

const DENSITIES: { value: Density; label: string; icon: typeof Rows3 }[] = [
  { value: "standard", label: "标准卡片", icon: LayoutGrid },
  { value: "compact", label: "紧凑卡片", icon: Rows3 },
]

/**
 * The controls over the list, under the summary and over the cards: the size
 * they are drawn at on the left, and on the right the three ways to narrow or
 * order them -- group, search, sort.
 *
 * The density pair is two icons and no words. `标准` and `紧凑` are the widest
 * labels in this row and the least informative: the icons already draw a grid and
 * a stack, and a translated build would have to find two more words that fit the
 * same 60px.
 *
 * Grouping is still the only filter with a control of its own. A row of country
 * flags was in the plan and it does not survive a phone -- eight regions is eight
 * more buttons on a line that already scrolls -- and what a visitor wants of a
 * region is its machines together, which is the 地区 sort. Searching by name is
 * the other half: it is behind a button because a list of eight nodes does not
 * need a text field sitting open over it, and the field that appears is the same
 * one a keyboard can reach.
 *
 * Nothing here is a `<div onClick>`. The chips and the density pair are buttons
 * carrying `aria-pressed`, the order is a native `<select>`, and the arrow beside
 * it is a button whose label says which way it points and what a press will do.
 * `aria-sort` is not used: it is legal only on a table's header cell, and the
 * state it describes is already in the select's value and the arrow's label.
 */
export function Toolbar({
  nodes, found, shown, group, onGroup, order, onOrder, density, onDensity, query, onQuery,
}: Props) {
  const groups = groupsOf(nodes)
  const ungrouped = found.filter((n) => !n.group).length
  const tabs = [
    [null, "全部", found.length] as const,
    ...groups.map((g) => [g, g, found.filter((n) => n.group === g).length] as const),
    ...(ungrouped ? [["", "未分组", ungrouped] as const] : []),
  ]
  const hint = sortFor(order.key).hint
  const direction = order.dir === "asc" ? "升序" : "降序"

  return (
    // Wraps rather than scrolls: a 360px phone gets a second line instead of a
    // control that has slid out of reach. On that phone the second line is the
    // groups -- they are the only part here that is a strip, and a strip wedged
    // between two buttons is a strip whose last chip is cut in half by one. The
    // rule under it is the seam between the controls and the list they control.
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b pb-3">
      <div className="flex shrink-0 items-center gap-2">
        <div role="group" aria-label="卡片密度" className="flex h-8 items-center gap-0.5 rounded-lg border bg-card-2 p-0.5">
          {DENSITIES.map(({ value, label, icon }) => (
            <button
              key={value}
              aria-pressed={density === value}
              aria-label={label}
              title={label}
              onClick={() => onDensity(value)}
              className={cn(
                "grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                density === value
                  ? "bg-selected text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Glyph icon={icon} box="sm" />
            </button>
          ))}
        </div>
        {/* The count belongs beside the switch that changes it: it is the receipt
            for the filters on the right, and on a phone the two are one line. */}
        <span className="tnum truncate text-2xs text-muted-foreground">
          {shown === nodes.length ? `${nodes.length} 台` : `${shown} / ${nodes.length} 台`}
        </span>
      </div>

      {/* Group names are free text, so they carry a prefix no key of the 全部
          tab can share. The row scrolls rather than wraps: twelve groups wrapped
          into four lines push the list off a phone's screen. The scrollbar is
          hidden because the row is a strip of tabs, not a text pane -- a
          half-visible chip still says there is more, and Tab scrolls the strip. */}
      {groups.length > 0 && (
        <div
          role="group"
          aria-label="分组"
          className="order-last -mx-0.5 flex w-full min-w-0 gap-1 overflow-x-auto px-0.5 py-0.5 [scrollbar-width:none] sm:order-none sm:w-auto sm:flex-1 [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map(([value, label, count]) => (
            <button
              key={value === null ? "*" : `=${value}`}
              aria-pressed={group === value}
              // A tab the search emptied is a tab that opens on nothing; it stays
              // on the strip so the row does not reflow under the typing finger,
              // and stops taking presses.
              disabled={count === 0}
              onClick={() => onGroup(value)}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-2xs outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-40",
                group === value
                  ? "border-brand/40 bg-brand/10 font-medium text-brand"
                  : "border-transparent text-muted-foreground hover:bg-card hover:text-foreground",
              )}
            >
              {label}
              <span className="tnum opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex h-8 shrink-0 items-center gap-2">
        <div className="flex h-8 items-center rounded-lg border bg-card">
          <div className="relative flex items-center">
            <select
              aria-label="排序"
              title={hint}
              value={order.key}
              onChange={(e) => onOrder(nextOrder(order, e.target.value as SortKey))}
              className="h-8 cursor-pointer appearance-none rounded-lg bg-transparent pr-7 pl-2.5 text-2xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
            className="size-7 rounded-md"
            aria-label={`${hint}，${direction}；按下改为${order.dir === "asc" ? "降序" : "升序"}`}
            title={`${hint}（${direction}）`}
            onClick={() => onOrder(nextOrder(order, order.key))}
          >
            <Glyph icon={order.dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow} box="sm" />
          </Button>
        </div>

        <SearchBox query={query} onQuery={onQuery} />
      </div>
    </div>
  )
}

/**
 * A button that becomes a field.
 *
 * Eight nodes need no search box over them, and an input that is always there
 * spends 150px of a toolbar to do nothing. Pressed, it takes the width it needs
 * and puts the caret in it; Escape closes it, and so does emptying it, because a
 * field with nothing in it is a field that has done its job.
 */
function SearchBox({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const [open, setOpen] = useState(false)
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    field.current?.focus()
  }, [open])

  const close = () => {
    setOpen(false)
    onQuery("")
  }

  if (!open) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 rounded-lg border bg-card text-muted-foreground hover:text-foreground"
        aria-label="搜索节点名称"
        title="搜索节点名称"
        onClick={() => setOpen(true)}
      >
        <Glyph icon={Search} box="sm" />
      </Button>
    )
  }

  return (
    <div className="relative shrink-0">
      <Glyph icon={Search} box="sm" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={field}
        type="search"
        value={query}
        aria-label="搜索节点名称"
        placeholder="名称"
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close()
        }}
        onBlur={() => {
          if (!query) setOpen(false)
        }}
        className="h-8 w-32 rounded-lg border bg-card pr-6 pl-7 text-2xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-44 [&::-webkit-search-cancel-button]:hidden"
      />
      <button
        aria-label="关闭搜索"
        title="关闭搜索"
        onClick={close}
        className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Glyph icon={X} box="sm" />
      </button>
    </div>
  )
}
