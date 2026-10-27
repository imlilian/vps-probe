import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { percentText } from "@/components/Meter"
import { CompactStrip } from "@/components/PingPanel"
import { Country, statusDot, statusLabel } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { bytes, daysUntil, money, percent, rate, uptime } from "@/lib/format"
import type { SortKey } from "@/lib/sort"
import { cn } from "@/lib/utils"

/**
 * A name and a figure on one line, the way a meter labels itself: the word first
 * because it is a name rather than a unit, and muted because the figure is what
 * the eye came for.
 */
function Figure({ label, pct }: { label: string; pct: number | null }) {
  return (
    <span className="tnum inline-flex shrink-0 items-baseline gap-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium">{percentText(pct)}</span>
    </span>
  )
}

/**
 * The reading the list is currently ordered by, for the keys the row does not
 * already show.
 *
 * Eleven chips above the list, and a row that shows only CPU and memory: sorting
 * by 速率 or 到期 reordered the page with nothing on screen to explain why. So
 * the one figure the order is made of is on the line -- and only that one,
 * because a row has 48px and its name still has to fit.
 *
 * CPU, memory and price carry their own columns already, and the name, region and
 * operator keys are visible as the row's own identity.
 */
function orderedBy(node: Node, key: SortKey): { label: string; text: ReactNode } | null {
  const m = node.online ? node.metrics : null
  switch (key) {
    case "rate":
      return m ? { label: "速率", text: rate(m.net_rx + m.net_tx) } : null
    case "today":
      return { label: "今日", text: bytes(node.day_rx + node.day_tx) }
    case "disk":
      return m ? { label: "硬盘", text: percentText(percent(m.disk_used, m.disk_total)) } : null
    case "uptime":
      return m ? { label: "在线", text: uptime(m.uptime) } : null
    case "expiry": {
      const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
      if (days === null) return { label: "到期", text: "不限期" }
      return { label: "到期", text: days < 0 ? "已过期" : `${days} 天` }
    }
    default:
      return null
  }
}

/**
 * The compact list's row: the same node as [NodeCard], forty-eight pixels tall
 * and about a tenth of the information.
 *
 * A row of its own rather than a dense variant of the card. The two share no
 * structure -- a card is a four-cell grid above two blocks above a footnote, a
 * row is one line above one band -- so a `dense` prop would have grown a branch
 * around every element inside it. What they do share is imported: the flag, the
 * state dot, the latency history behind it.
 *
 * What a row keeps is what a scan answers: which machine, is it up, how busy,
 * and was its line well this hour. Memory is kept beside CPU because the two are
 * the pair that says whether a box has room. Everything the row drops -- disk,
 * load, sockets, expiry, the per-probe figures -- is on the node's own page, one
 * press away.
 */
export function NodeRow({ node, order, onOpen }: { node: Node; order?: SortKey; onOpen: () => void }) {
  const m = node.online ? node.metrics : null
  const billing = node.price > 0 ? money(node.price, node.currency) : ""
  const status = statusLabel(node)
  const extra = order ? orderedBy(node, order) : null

  return (
    <Card
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      title={`${node.name} · ${status}`}
      aria-label={`${node.name}，${status}`}
      data-node={node.id}
      // Muted when it stops reporting: the figures are the last ones it sent,
      // and the whole row says so rather than the dot alone. Focus is drawn as
      // the same border the pointer gets on hover, plus the button's ring.
      className={cn(
        "min-w-0 cursor-pointer gap-0 px-3 py-2.5 outline-none transition-colors hover:border-ring focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        !node.online && "text-muted-foreground",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* The dot takes the place the state badge has on a card: in a column of
            rows the dots line up, and one that is not green is the thing to find. */}
        <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(node))} title={status} />
        <Country node={node} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={node.name}>{node.name}</h3>
        <Figure label="CPU" pct={m ? m.cpu : null} />
        <Figure label="内存" pct={m ? percent(m.mem_used, m.mem_total) : null} />
        {/* Whichever figure the list is ordered by, when it is not one of the
            two above: see [orderedBy]. */}
        {extra && (
          <span className="tnum inline-flex shrink-0 items-baseline gap-1">
            <span className="text-2xs text-muted-foreground">{extra.label}</span>
            <span className="text-xs font-medium">{extra.text}</span>
          </span>
        )}
        {/* The same string the card shows, a step muted: at the end of a row it
            is the least urgent thing on the line, but it is what the 价格 sort
            sorts by, so it has to be on the line. */}
        {billing && <span className="tnum shrink-0 text-xs text-muted-foreground">{billing}</span>}
      </div>
      {/* No line, no strip: an offline machine's last hour would read as a live
          one (D16). */}
      {node.online && <CompactStrip node={node} />}
    </Card>
  )
}
