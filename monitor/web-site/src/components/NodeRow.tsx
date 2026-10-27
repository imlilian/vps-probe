import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { percentText } from "@/components/Meter"
import { Billing } from "@/components/Billing"
import { Country, deployed, Figure, monthUsage, statusDot, statusLabel } from "@/components/NodeCard"
import { ProbeLines } from "@/components/PingPanel"
import type { Node } from "@/lib/api"
import { bytes, percent, rate, splitUnit, uptimeShort } from "@/lib/format"
import { ArrowDown, ArrowUp, Clock, WifiOff } from "lucide-react"
import { cn } from "@/lib/utils"

/** One of the four readings across the top: a name, a figure, a 4px bar. */
function Mini({ label, value, pct, tone, title }: {
  label: string
  value: ReactNode
  pct: number | null
  tone: string
  title?: string
}) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[0.625rem] leading-3 font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
        <span className="tnum shrink-0 text-2xs font-semibold">{value}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-rail">
        <div
          className={cn("h-full rounded-full bg-linear-to-r transition-[width] duration-500", tone)}
          style={{ width: `${filled}%` }}
        />
      </div>
    </div>
  )
}

function Speed({ dir, value }: { dir: "rx" | "tx"; value: string }) {
  const [figure, unit] = splitUnit(value)
  const down = dir === "rx"
  return (
    <span className="inline-flex items-baseline gap-0.5">
      <Glyph
        icon={down ? ArrowDown : ArrowUp}
        box="sm"
        className={down ? "text-emerald-600 dark:text-emerald-400" : "text-blue-600 dark:text-blue-400"}
      />
      <span className="tnum text-2xs font-semibold">{figure}</span>
      {unit && <span className="text-2xs text-muted-foreground">{unit}</span>}
    </span>
  )
}

/**
 * The compact card: the same node at a quarter of the height, for a visitor who
 * wants the fleet in one screen rather than one machine in one glance.
 *
 * A component of its own rather than a `dense` prop on [NodeCard]. The two share
 * no structure -- a card is a head above a 2x2 grid above two wells, this is a
 * head above one row of four and two lines -- so a flag would have grown a branch
 * around every element inside it. What they do share is imported: the flag, the
 * dot, the state, the probe history.
 *
 * It keeps four resources instead of the two the old row had, because four 60px
 * meters in one row are cheaper than the line they replaced: the row it grew out
 * of showed CPU and memory and then, for the sort key it happened to be ordered
 * by, one more figure -- which meant the same card said different things
 * depending on a control two hundred pixels above it. Disk and load are always
 * there now, so a scan does not depend on the sort.
 */
export function NodeRow({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.online ? node.metrics : null
  const loadPct = node.cpu_cores > 0 && m ? (m.load[0] / node.cpu_cores) * 100 : null
  const status = statusLabel(node)

  return (
    <Card
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      title={`${node.name} · ${status}`}
      aria-label={`${node.name}，${status}`}
      data-node={node.id}
      // Focus is drawn as the same border the pointer gets on hover, plus the
      // button's ring.
      className="min-w-0 cursor-pointer gap-0 p-3 outline-none transition-[box-shadow,border-color] duration-200 hover:border-ring/50 hover:shadow-raise focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-center gap-1.5">
        <Country node={node} />
        {/* The dot takes the place the state badge has on a card: in a column of
            compact cards the dots line up, and one that is not green is the thing
            to find. */}
        <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(node))} title={status} />
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold" title={node.name}>{node.name}</h3>
        {node.online ? (
          <span className="tnum inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-card-2 px-1 py-0.5 text-[0.625rem] leading-3 text-muted-foreground">
            <Glyph icon={Clock} box="sm" className="size-3" />
            {m ? uptimeShort(m.uptime) : "—"}
          </span>
        ) : deployed(node) ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] leading-3 font-semibold text-destructive">
            <Glyph icon={WifiOff} box="sm" className="size-3" />
            离线
          </span>
        ) : null}
      </div>

      {deployed(node) ? (
        <>
          <div className="mt-2 grid grid-cols-4 gap-2">
            <Mini label="CPU" value={percentText(m ? m.cpu : null)} pct={m ? m.cpu : null} tone="from-blue-500 to-indigo-500" />
            <Mini
              label="内存"
              value={m ? percentText(percent(m.mem_used, m.mem_total)) : "—"}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              tone="from-violet-500 to-purple-500"
              title={m ? `${bytes(m.mem_used)} / ${bytes(m.mem_total)}` : undefined}
            />
            <Mini
              label="硬盘"
              value={m ? percentText(percent(m.disk_used, m.disk_total)) : "—"}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              tone="from-amber-500 to-orange-500"
              title={m ? `${bytes(m.disk_used)} / ${bytes(m.disk_total)}` : undefined}
            />
            <Mini
              label="负载"
              value={m ? m.load[0].toFixed(2) : "—"}
              pct={loadPct}
              tone="from-pink-500 to-rose-400"
              title={m ? `5m ${m.load[1].toFixed(2)} · 15m ${m.load[2].toFixed(2)}` : undefined}
            />
          </div>

          {/* The hour, as figures: a strip 60px wide is ten blocks of six pixels
              and shows no run at all, so the compact card says the same thing in
              the two numbers that coloured it. */}
          {node.online && <ProbeLines node={node} />}

          <div className="mt-2 flex items-baseline justify-between gap-2">
            <span className="flex items-baseline gap-2">
              <Speed dir="rx" value={m ? rate(m.net_rx) : "—"} />
              <Speed dir="tx" value={m ? rate(m.net_tx) : "—"} />
            </span>
            <Figure text={bytes(monthUsage(node))} size="xs" className="shrink-0" title="本周期已用流量" />
          </div>

          <Billing node={node} className="mt-2 text-2xs" />
        </>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">还没有接入</p>
      )}
    </Card>
  )
}
