import type { ReactNode } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Server, Wallet, type LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { percentText } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { bytes, moneyParts, rate, splitUnit } from "@/lib/format"
import { RATES_AS_OF } from "@/lib/rates"
import { busiest, due, fleet, live, residual, today, type Due } from "@/lib/stats"
import { cn } from "@/lib/utils"

/** Every figure on this row is drawn in it: see lib/rates.ts. */
const VALUED_IN = "USD"

function Tile({ icon, label, hint, note, children }: {
  icon: LucideIcon
  label: string
  /**
   * A qualifier that belongs to the label rather than to a line of its own:
   * `流量（实时/今日）` names the two columns without spending a row on them.
   * Measured in a system face the whole head is 116px against the 130px a card
   * has on a 360px screen -- the narrowest phone still shipping -- so it does
   * not need a fallback for a smaller one.
   */
  hint?: ReactNode
  /** The line under the figure, pinned to the bottom. */
  note?: ReactNode
  children: ReactNode
}) {
  return (
    // One height for all four: 14 + 16 (label) + 8 + 32 (figure) + 8 + 16
    // (note) + 14. Auto-height made every tile shrink to its own content, so a
    // two-line traffic table and a single percentage sat in boxes of different
    // shapes and the shortest one read as crowded; the fixed box is what lets
    // the same figure breathe in all of them.
    <Card className="@container flex min-h-27 flex-col gap-0 p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Glyph icon={icon} />
        <span className="min-w-0 truncate">
          {label}
          {hint && <span className="text-2xs opacity-70">{hint}</span>}
        </span>
      </div>
      <div className="mt-2">{children}</div>
      {note}
    </Card>
  )
}

/**
 * The figure a card exists for. A 32px line box around a 24px glyph rather than
 * `leading-none`: the number then has 4px of air above and below it inside its
 * own line, which is what keeps it from touching the label and the note.
 */
function Big({ children }: { children: ReactNode }) {
  return <div className="tnum text-2xl font-semibold leading-8 tracking-tight">{children}</div>
}

/**
 * The line under it: what the figure is made of, or what to do about it. `mt-auto`
 * pins it to the bottom of the fixed box, so four cards of unequal content line
 * up along it.
 */
function Note({ children, tone, title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <div title={title} className={cn("mt-auto truncate text-xs", tone ?? "text-muted-foreground")}>
      {children}
    </div>
  )
}

/**
 * The estimate, split: the mark as a unit, the amount as the figure. Set as one
 * string, `US$795` makes the symbol as loud and as wide as the number it belongs
 * to, which is the mistake `TCP 412` makes in the other direction; the gap
 * between them is what keeps the pair from reading as three digits and a stray
 * character.
 */
function Money({ amount, currency }: { amount: number; currency: string }) {
  const { symbol, value } = moneyParts(amount, currency, 0)
  return (
    <Big>
      <span className="mr-1.5 text-base font-medium text-muted-foreground">{symbol}</span>
      {value}
    </Big>
  )
}

/**
 * One figure of the traffic table: the number leads, its unit trails a step
 * smaller, as in the socket counts.
 *
 * The value steps down a size on a narrow card because four of these have to
 * share a phone's 130px of card. `whitespace-nowrap` is the part that matters:
 * the space in "39.6 MB/s" is a line-break opportunity, and a 158px card took
 * it, leaving the figure on one line and `MB/s` on the next.
 */
function Cell({ text }: { text: string }) {
  const [value, unit] = splitUnit(text)
  return (
    <span className="tnum whitespace-nowrap text-right">
      <span className="text-xs font-medium text-foreground @[220px]:text-sm">{value}</span>
      {unit && <span className="ml-1 text-2xs text-muted-foreground">{unit}</span>}
    </span>
  )
}

/**
 * The one thing this row says that a node card cannot: a bill to schedule. An
 * expired machine outranks one that merely expires, since it is already dark.
 */
function expiry(due: Due): { text: string; tone?: string; title?: string } {
  // Two different facts, and adding them makes a third one that is false: an
  // expired machine is not "due within 30 days", it is already dark. The count
  // that shows is the worse of the two; the other one is in the tooltip, where
  // it has room to say which is which.
  if (due.expired > 0) {
    return {
      text: `${due.expired} 台已过期`,
      tone: "text-destructive",
      title: due.soon > 0 ? `另有 ${due.soon} 台将在 30 天内到期` : undefined,
    }
  }
  if (due.soon > 0) return { text: `${due.soon} 台 30 天内到期`, tone: "text-warn" }
  return { text: "无近期到期" }
}

/**
 * Four tiles, not seven: what is running, what is busiest, what it moved, and
 * what the remaining time is worth. CPU and memory aggregates were dropped --
 * one busy machine is the signal, and a fleet average hides it -- and so was the
 * cumulative byte total, which every node resets on its own billing date and so
 * grows without ever describing a period.
 */
export function Overview({ nodes }: { nodes: Node[] }) {
  const { total, online, offline } = fleet(nodes)
  const top = busiest(nodes)
  const day = today(nodes)
  const now = live(nodes)
  const worth = residual(nodes)
  const ending = expiry(due(nodes))

  return (
    <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-4">
      <Tile
        icon={Server}
        label="节点"
        note={<Note>{offline > 0 ? `${offline} 个离线` : total > 0 ? "全部在线" : "还没有节点"}</Note>}
      >
        {/* The total is a unit, not a second figure: at the same 24px as the
            count, `7 / 8` reads as two numbers of equal standing and the pair
            fills the card's widest line. */}
        <Big>
          {online}
          <span className="ml-1 text-base font-medium text-muted-foreground">/ {total}</span>
        </Big>
      </Tile>

      <Tile
        icon={Activity}
        label="最忙节点"
        note={
          <Note tone={top && top.cpu >= 85 ? "font-medium text-foreground" : undefined}>
            {top ? top.node.name : "无在线节点"}
          </Note>
        }
      >
        {/* The same precision as the meter on the card that figure comes from:
            one decimal below ten, whole numbers above. `46.2%` here against
            `46%` there, a screen apart, reads as two different machines. */}
        <Big>{top ? percentText(top.cpu) : "—"}</Big>
      </Tile>

      {/* Two directions read across two time scopes: what the line is doing now,
          and what it has moved since midnight. The scopes are named in the title
          rather than over the columns -- `MB/s` already says which column is the
          live one, and a header row of 实时／今日 was a line of words the eye
          skipped on its way to the figures. The arrows keep the rows, because a
          direction is a symbol in every language while its name is not.

          Four figures and two units in a phone's 130px is the tightest thing on
          this page: measured in a system sans face it comes to 130px, exactly
          what the card has, and the columns are content-sized, so any face a
          shade wider spends the card's right padding rather than the page's. */}
      <Tile icon={ArrowDownUp} label="流量" hint="（实时/今日）">
        {/* No note: the two rows are the whole card, and the box is already a
            fixed height, so there is nothing left to prop up. The rows get the
            spare space as a wider gap instead of a footnote nobody needed. */}
        <div className="grid w-full grid-cols-[auto_1fr_1fr] items-baseline gap-x-1.5 gap-y-1.5">
          <Glyph icon={ArrowDown} box="sm" className="self-center" />
          <Cell text={rate(now.rx)} />
          <Cell text={bytes(day.rx)} />

          <Glyph icon={ArrowUp} box="sm" className="self-center" />
          <Cell text={rate(now.tx)} />
          <Cell text={bytes(day.tx)} />
        </div>
      </Tile>

      <Tile
        icon={Wallet}
        label="剩余价值"
        note={
          <Note
            tone={ending.tone}
            // Both facts share the tooltip: what the count is made of, and the
            // other expiry count the line had no room for.
            title={[
              ending.title,
              worth ? `${worth.counted} 台计入，${worth.left} 台未计入；按 ${RATES_AS_OF} 汇率折成美元` : "没有可估价的机器",
            ].filter(Boolean).join(" · ")}
          >
            {ending.text}
          </Note>
        }
      >
        {worth ? <Money amount={worth.usd} currency={VALUED_IN} /> : <Big>—</Big>}
      </Tile>
    </div>
  )
}
