import type { ReactNode } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Server, Wallet, type LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import type { Node } from "@/lib/api"
import { bytes, moneyParts, rate, splitUnit } from "@/lib/format"
import { busiest, due, fleet, live, residual, today, type Due } from "@/lib/stats"
import { cn } from "@/lib/utils"

function Tile({ icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <Card className="@container gap-0 p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Glyph icon={icon} />
        {label}
      </div>
      {children}
    </Card>
  )
}

/** The figure a card exists for. */
function Big({ children }: { children: ReactNode }) {
  return <div className="tnum mt-1.5 text-2xl font-semibold leading-none">{children}</div>
}

/**
 * The line under it: what the figure is made of, or what to do about it. Pinned
 * to the bottom so four cards of unequal content still line up.
 */
function Note({ children, tone, title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <div title={title} className={cn("mt-auto truncate pt-2 text-xs", tone ?? "text-muted-foreground")}>
      {children}
    </div>
  )
}

/**
 * The estimate, split: the mark as a unit, the amount as the figure. Set as one
 * string, `¥795` makes the symbol as loud and as wide as the number it belongs
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
  if (due.expired > 0 && due.soon > 0) {
    return {
      text: `${due.soon + due.expired} 台 30 天内到期`,
      tone: "text-destructive",
      title: `${due.expired} 台已过期，${due.soon} 台即将到期`,
    }
  }
  if (due.expired > 0) return { text: `${due.expired} 台已过期`, tone: "text-destructive" }
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
      <Tile icon={Server} label="节点">
        <Big>
          {online}
          <span className="text-muted-foreground"> / {total}</span>
        </Big>
        <Note>{offline > 0 ? `${offline} 个离线` : total > 0 ? "全部在线" : "还没有节点"}</Note>
      </Tile>

      <Tile icon={Activity} label="最忙节点">
        <Big>{top ? `${top.cpu.toFixed(1)}%` : "—"}</Big>
        <Note tone={top && top.cpu >= 85 ? "font-medium text-foreground" : undefined}>
          {top ? top.node.name : "无在线节点"}
        </Note>
      </Tile>

      {/* Two directions read across two time scopes: what the line is doing
          now, and what it has moved since midnight. The arrows head the rows
          rather than the columns because they are the same in every language --
          a row of 实时／今日 would be the words the eye skips anyway, and their
          width changes with the translation while the figures cannot.

          Four figures and two units in a phone's 130px is the tightest thing on
          this page: measured in a system sans face it comes to 130px, exactly
          what the card has, and the columns are content-sized, so any face a
          shade wider spends the card's right padding rather than the page's. */}
      <Tile icon={ArrowDownUp} label="流量">
        <div className="mt-1.5 grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-1 gap-y-1 text-2xs text-muted-foreground">
          <span />
          <span className="text-right">实时</span>
          <span className="text-right">今日</span>

          <Glyph icon={ArrowDown} box="sm" className="self-center" />
          <Cell text={rate(now.rx)} />
          <Cell text={bytes(day.rx)} />

          <Glyph icon={ArrowUp} box="sm" className="self-center" />
          <Cell text={rate(now.tx)} />
          <Cell text={bytes(day.tx)} />
        </div>
      </Tile>

      <Tile icon={Wallet} label="剩余价值">
        {/* Centred between the label and the note rather than pinned under the
            label: one figure is all this card has, and hung from the top it left
            a hole in the middle of a card that its neighbour made tall. */}
        <div className="flex flex-1 items-center">
          {worth ? <Money amount={worth.amount} currency={worth.currency} /> : <Big>—</Big>}
        </div>
        <Note
          tone={ending.tone}
          title={worth ? `${worth.counted} 台计入，${worth.left} 台无价格或无到期日` : "没有可估价的机器"}
        >
          {ending.text}
        </Note>
      </Tile>
    </div>
  )
}
