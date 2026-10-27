import { Card } from "@/components/ui/card"
import { percentText } from "@/components/Meter"
import { CompactStrip } from "@/components/PingPanel"
import { Country, statusDot, statusLabel } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { money, percent } from "@/lib/format"
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
export function NodeRow({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.online ? node.metrics : null
  const billing = node.price > 0 ? money(node.price, node.currency) : ""
  const status = statusLabel(node)

  return (
    <Card
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      title={`${node.name} · ${status}`}
      // Muted when it stops reporting: the figures are the last ones it sent,
      // and the whole row says so rather than the dot alone.
      className={cn(
        "min-w-0 cursor-pointer gap-0 px-3 py-2.5 transition-colors hover:border-ring",
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
