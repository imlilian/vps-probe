import type { ReactNode } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Server, Wallet } from "lucide-react"

import { Card } from "@/components/ui/card"
import type { Node } from "@/lib/api"
import { bytes, money, rate } from "@/lib/format"
import { busiest, due, fleet, live, residual, today, type Due } from "@/lib/stats"
import { cn } from "@/lib/utils"

function Tile({ icon: Icon, label, children }: { icon: typeof Server; label: string; children: ReactNode }) {
  return (
    <Card className="@container gap-0 p-3.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
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

/** In and out, the form every traffic figure takes on this page. */
function Flow({ rx, tx, format }: { rx: number; tx: number; format: (n: number) => string }) {
  const lane = (Icon: typeof ArrowDown, value: number) => (
    <span className="inline-flex items-baseline gap-1">
      <Icon className="size-3 self-center text-muted-foreground" />
      <span className="font-medium">{format(value)}</span>
    </span>
  )
  // Two lanes side by side once the tile is wide enough, stacked when it is not:
  // in a phone's two-column row a card is about 158px, where "↓ 12.3 GB" twice
  // over does not fit. Querying the card rather than the viewport keeps this
  // right in the four-column desktop row too, where a card is a third as wide as
  // the screen.
  return (
    <span className="tnum flex flex-col gap-0.5 text-sm @[200px]:flex-row @[200px]:items-baseline @[200px]:gap-3">
      {lane(ArrowDown, rx)}
      {lane(ArrowUp, tx)}
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

      <Tile icon={ArrowDownUp} label="流量">
        <div className="mt-1.5 space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="w-7 shrink-0 text-2xs text-muted-foreground">今日</span>
            <Flow rx={day.rx} tx={day.tx} format={bytes} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="w-7 shrink-0 text-2xs text-muted-foreground">实时</span>
            <Flow rx={now.rx} tx={now.tx} format={rate} />
          </div>
        </div>
      </Tile>

      <Tile icon={Wallet} label="剩余价值">
        <Big>{worth ? money(worth.amount, worth.currency, 0) : "—"}</Big>
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
