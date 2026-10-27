import type { CSSProperties } from "react"
import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react"
import {
  siAlmalinux, siAlpinelinux, siArchlinux, siCentos, siDebian, siFedora, siLinux, siOpensuse, siRedhat,
  siRockylinux, siUbuntu, type SimpleIcon,
} from "simple-icons"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { Meter } from "@/components/Meter"
import { PingPanel } from "@/components/PingPanel"
import type { Node } from "@/lib/api"
import { bytes, cpuName, cycle, daysUntil, FOREVER, money, osName, pair, percent, rate, sinceSeen, splitUnit, uptime } from "@/lib/format"
import { cn } from "@/lib/utils"

// Emitted as files and fetched on first use, so a page carries only the flags its
// nodes are in rather than all 265. vite.config.ts keeps them from being inlined
// into the bundle as data URLs. The simplified set, because this theme is
// embedded in the hub binary: flag-icons' detailed emblems total 1.95 MiB against
// 174 KiB here, a difference invisible at 18 by 12 pixels.
const FLAGS = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("/node_modules/country-flag-icons/3x2/*.svg", {
      query: "?url",
      import: "default",
      eager: true,
    }),
  ).map(([path, url]) => [path.match(/([\w-]+)\.svg$/)![1], url]),
)

// Matched against the whole release name, since "Red Hat Enterprise Linux" and
// "Raspbian GNU/Linux" do not lead with one word to key on. The distributions a
// VPS ships with; the rest take the penguin. Each logo costs 1-6 KB of entry
// bundle, so the list stays at what hosts offer.
const DISTROS: [string, SimpleIcon][] = [
  ["debian", siDebian], ["raspbian", siDebian], ["ubuntu", siUbuntu], ["alpine", siAlpinelinux],
  ["centos", siCentos], ["rocky", siRockylinux], ["almalinux", siAlmalinux], ["red hat", siRedhat],
  ["fedora", siFedora], ["arch", siArchlinux], ["opensuse", siOpensuse],
]

/**
 * This period's usage as the plan meters it. The hub computes it; the switch
 * below serves only a hub from before `month_used`.
 */
function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
export function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

/**
 * The dot plus how long the machine has been up, or once it is gone, how long it
 * has been absent -- the first question asked of an offline node. Both are
 * durations, so the badge keeps its shape either way.
 *
 * Exported with [statusDot] below: the compact row draws the same state as a
 * bare dot, and the two must not disagree about which of the three it is.
 */
export function statusLabel(node: Node): string {
  const down = sinceSeen(node)
  return node.online
    ? `在线 ${node.metrics ? uptime(node.metrics.uptime) : ""}`.trim()
    : deployed(node)
      ? `离线 ${down >= 60 ? uptime(down) : ""}`.trim()
      : "未接入"
}

/** Reporting, gone but known, or never connected. */
export function statusDot(node: Node): string {
  return node.online ? "bg-online" : deployed(node) ? "bg-offline" : "bg-muted-foreground/40"
}

export function Status({ node }: { node: Node }) {
  return (
    // Muted once it stops reporting: the figures on the page are genuine, merely
    // no longer current.
    <Badge
      className={cn("tnum shrink-0 gap-1.5 font-normal", !node.online && "text-muted-foreground")}
    >
      <span className={cn("size-1.5 rounded-full", statusDot(node))} />
      {statusLabel(node)}
    </Badge>
  )
}

/** Where the machine is: its flag, or the bare code for one the set lacks. */
export function Country({ node }: { node: Node }) {
  if (!node.country) return null
  const src = FLAGS[node.country]
  if (!src) {
    return (
      <Badge className="shrink-0 font-normal text-muted-foreground">
        {node.country}
      </Badge>
    )
  }
  return (
    <img
      src={src}
      alt={node.country}
      title={node.country}
      className="h-3 w-4.5 shrink-0 rounded-xs ring-1 ring-foreground/10"
    />
  )
}

/**
 * The distribution's logo in its brand colour, standing in for the name, which
 * shows on hover. Mixed toward white on the dark theme, where AlmaLinux's black
 * and CentOS's navy would otherwise vanish.
 */
function OsIcon({ os }: { os: string }) {
  const name = os.toLowerCase()
  const icon = DISTROS.find(([key]) => name.includes(key))?.[1] ?? siLinux
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      style={{ "--brand": `#${icon.hex}` } as CSSProperties}
      className="size-3 shrink-0 fill-(--brand) dark:fill-[color-mix(in_oklab,var(--brand)_60%,white)]"
    >
      <title>{osName(os)}</title>
      <path d={icon.path} />
    </svg>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

// No date means nothing expires: a permanent host, or one with no renewal set. A
// blank corner asserts neither. The days are the hub's count: it renews an online
// node by its own calendar, and counting on the visitor's would show the node
// expired for hours before that. Only a hub from before `expires_in` leaves the
// count to the browser.
function Expiry({ node }: { node: Node }) {
  const days = node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
  if (days === null) return <span className="text-xs text-muted-foreground" title="永不到期">{FOREVER}</span>
  const tone = days < 0 ? "text-destructive" : days <= 7 ? "text-warn" : "text-muted-foreground"
  return (
    <span className={cn("tnum text-xs", tone)}>
      {days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`}
    </span>
  )
}

/**
 * A socket count: the figure leads, its unit trails in a lighter and smaller
 * face. `412 TCP` is one glance; `TCP 412` makes the eye step over a word it
 * already knows before reaching the number it came for. A node that has never
 * reported keeps the dash, so the row holds its shape either way.
 */
function Count({ value, label }: { value: number | undefined; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="tnum text-sm font-medium">{value ?? "—"}</span>
      <span className="text-2xs text-muted-foreground">{label}</span>
    </span>
  )
}

/**
 * Throughput in one direction, set the way a count is: arrow, figure, then the
 * unit a step smaller and muted. Left as one string, `39.6 MB/s` is three things
 * at one weight, and the row above `412 TCP` reads as if it were a different
 * component -- it is not, it is the same rule about which half of a measurement
 * the eye came for.
 */
function Speed({ icon, value }: { icon: LucideIcon; value: string }) {
  const [figure, unit] = splitUnit(value)
  return (
    <span className="tnum inline-flex items-baseline gap-1">
      <Glyph icon={icon} box="sm" className="self-center" />
      <span className="text-sm font-medium">{figure}</span>
      {unit && <span className="text-2xs text-muted-foreground">{unit}</span>}
    </span>
  )
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics
  // Load against the core count it competes for, so one number says whether the
  // machine has room. A load of 1.0 is idle on four cores and saturated on one.
  const loadPct = m && node.cpu_cores > 0 ? (m.load[0] / node.cpu_cores) * 100 : null
  const billing = node.price > 0 ? `${cycle(node.billing_cycle)} ${money(node.price, node.currency)}` : ""

  return (
    <Card
      onClick={onOpen}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // OS line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways. The truncate inside only takes effect
      // once the card is allowed to be narrower.
      className="min-w-0 cursor-pointer gap-0 p-4 transition-colors hover:border-ring"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Country node={node} />
            <h3 className="truncate font-medium" title={node.name}>{node.name}</h3>
          </div>
          <p className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {node.os && <OsIcon os={node.os} />}
            <span className="truncate">
              {node.os
                ? [osName(node.os), node.virt !== "none" && node.virt, node.arch].filter(Boolean).join(" · ")
                : "等待首次上报"}
            </span>
          </p>
        </div>
        {/* State right, identity left, one line each. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Status node={node} />
          <Expiry node={node} />
        </div>
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
            {/* The core count belongs beside the word CPU: it is what the
                percentage and the load averages are both measured against. */}
            <Meter
              label={`CPU · ${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              foot={cpuName(node.cpu_name) || "—"}
            />
            <Meter
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            <Meter
              label="负载"
              pct={loadPct}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
          </div>

          {/* Throughput gets its own block rather than a fifth tile: it is the
              figure read fastest, and the plan's allowance is what the bar under
              it measures. */}
          <div className="mt-4 space-y-2.5 border-t pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <Speed icon={ArrowDown} value={m ? rate(m.net_rx) : "—"} />
              <Speed icon={ArrowUp} value={m ? rate(m.net_tx) : "—"} />
            </div>
            <Meter
              label="本月流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
          </div>

          {/* The two things a card cannot show live: what the machine is doing
              at the socket level, and what it costs. */}
          <div className="mt-3 flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-baseline gap-3">
              <Count value={m?.tcp} label="TCP" />
              <Count value={m?.udp} label="UDP" />
              <Count value={m?.procs} label="进程" />
            </span>
            {billing && <span className="tnum shrink-0 text-xs text-muted-foreground">{billing}</span>}
          </div>

          {/* An offline node has no line to measure, and its last hour would be
              read as a live one. */}
          {node.online && <PingPanel node={node} />}
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. */
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          还没有接入。在后台生成安装命令并执行一次。
        </p>
      )}
    </Card>
  )
}
