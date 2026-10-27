import type { CSSProperties, ReactNode } from "react"
import { Activity, ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick, Network, WifiOff, type LucideIcon } from "lucide-react"
import {
  siAlmalinux, siAlpinelinux, siArchlinux, siCentos, siDebian, siFedora, siLinux, siOpensuse, siRedhat,
  siRockylinux, siUbuntu, type SimpleIcon,
} from "simple-icons"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { percentText } from "@/components/Meter"
import { PingPanel } from "@/components/PingPanel"
import type { Node } from "@/lib/api"
import {
  bytes, cpuName, cycle, daysUntil, FOREVER, moneyMark, moneyParts, osName, pair, percent, rate, sinceSeen,
  splitUnit, uptimeShort,
} from "@/lib/format"
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
export function monthUsage(node: Node): number {
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

/** `MAX`/`SUM`/`UP`/`DOWN`: how the plan counts, in the width of a tag. */
const MODE_LABEL: Record<string, string> = { up: "UP", down: "DOWN", max: "MAX", sum: "SUM" }

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
export function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

/**
 * How long the machine has been up, or once it is gone, how long it has been
 * absent -- the first question asked of an offline node.
 *
 * Exported with [statusDot] below: the compact card draws the same state as a
 * bare dot, and the two must not disagree about which of the three it is.
 */
export function statusLabel(node: Node): string {
  const down = sinceSeen(node)
  return node.online
    ? `在线 ${node.metrics ? uptimeShort(node.metrics.uptime) : ""}`.trim()
    : deployed(node)
      ? `离线 ${down >= 60 ? uptimeShort(down) : ""}`.trim()
      : "未接入"
}

/** Reporting, gone but known, or never connected. */
export function statusDot(node: Node): string {
  return node.online ? "bg-online" : deployed(node) ? "bg-offline" : "bg-muted-foreground/40"
}

/**
 * The state in one word, for a heading that has room for the word and a capsule
 * beside it for the number. `在线 92d 0h` in one badge was the two facts glued
 * together: it reads as a sentence where the page needs a state.
 */
export function statusWord(node: Node): string {
  return node.online ? "在线" : deployed(node) ? "离线" : "未接入"
}

export function Status({ node }: { node: Node }) {
  return (
    // Muted once it stops reporting: the figures on the page are genuine, merely
    // no longer current.
    <Badge
      className={cn("tnum shrink-0 gap-1.5 font-normal", !node.online && "text-muted-foreground")}
      title={statusLabel(node)}
    >
      <span className={cn("size-1.5 rounded-full", statusDot(node))} />
      {statusWord(node)}
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

/** Uptime, as a capsule: `92d 4h` needs no verb in any language. */
export function Uptime({ node }: { node: Node }) {
  return (
    <span
      className="tnum inline-flex shrink-0 items-center gap-1 rounded-md border bg-card-2 px-1.5 py-0.5 text-2xs text-muted-foreground"
      title={statusLabel(node)}
    >
      <Glyph icon={Clock} box="sm" />
      {node.metrics ? uptimeShort(node.metrics.uptime) : "—"}
    </span>
  )
}

/**
 * The same slot, once the node stops reporting. Words rather than a grey dot:
 * offline is the one state a visitor has to be told about, and the pill says it
 * for as long as it lasts. An expanded node keeps the pill too -- the head has
 * room for one badge, and which one that is follows the state.
 */
function Offline() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-2xs font-semibold text-destructive">
      <Glyph icon={WifiOff} box="sm" />
      离线
    </span>
  )
}

/**
 * One resource: an icon and a name, the figure, a 4px bar, and the datum the
 * figure is measured against.
 *
 * Four bars of one length and one colour was the old card, and it had two
 * faults. A black bar at 89% and a black bar at 4% have the same shape on a
 * white card, so the eye had to read the number anyway; and the bar was 6px,
 * the width of a rule, which made the card look like a form. Four colours, one
 * per resource, so a column of cards can be scanned by hue; 4px, so the bar is a
 * reading and not a border.
 */
function Resource({ icon, label, value, sub, pct, tone, title }: {
  icon: LucideIcon
  label: string
  value: ReactNode
  sub: string
  /** 0-100, or null where the metric has no ceiling. */
  pct: number | null
  tone: string
  title?: string
}) {
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-2xs font-medium text-muted-foreground">
          <Glyph icon={icon} box="sm" />
          <span className="truncate">{label}</span>
        </span>
        <span className="tnum shrink-0 text-sm font-bold tracking-tight" title={title}>{value}</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-rail">
        <div
          className={cn("h-full rounded-full bg-linear-to-r transition-[width] duration-500", tone)}
          style={{ width: `${filled}%` }}
        />
      </div>
      <p className="tnum mt-1.5 truncate text-2xs text-muted-foreground/90" title={sub}>{sub}</p>
    </div>
  )
}

/**
 * Throughput in one direction: the arrow and its two letters, then the figure
 * with the unit a step down.
 *
 * RX/TX rather than 入站/出站 -- see the same component in the summary. The two
 * directions keep the colours they have everywhere else on the page, emerald down
 * and blue up, so the traffic block and the tile above it are read the same way.
 */
function Speed({ dir, value }: { dir: "rx" | "tx"; value: string }) {
  const [figure, unit] = splitUnit(value)
  const down = dir === "rx"
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span
        className={cn(
          "flex shrink-0 items-center gap-0.5 text-2xs font-semibold",
          down ? "text-emerald-600 dark:text-emerald-400" : "text-blue-600 dark:text-blue-400",
        )}
      >
        <Glyph icon={down ? ArrowDown : ArrowUp} box="sm" />
        {down ? "RX" : "TX"}
      </span>
      <span className="tnum truncate text-sm font-semibold">{figure}</span>
      {unit && <span className="shrink-0 text-2xs text-muted-foreground">{unit}</span>}
    </span>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

/**
 * The quota bar is coloured by how much of the allowance is gone, not by which
 * direction the plan counts: a bar that is amber because the plan is `sum` says
 * nothing about the 20% it is showing, and the same amber on every card stops
 * meaning anything at all. Blue until it is worth noticing, then amber, then red.
 */
function quotaTone(pct: number | null): string {
  if (pct === null) return "from-emerald-500 to-teal-500"
  if (pct >= 90) return "from-red-500 to-orange-500"
  if (pct >= 70) return "from-amber-500 to-orange-500"
  return "from-blue-500 to-indigo-500"
}

/**
 * The traffic block: what the line is doing now, what the plan has used, and
 * what the machine is doing at the socket level -- one well inside the card
 * rather than three more rules across it.
 *
 * This is the block that made the card legible. Four flat figures and a bar the
 * full width of the card read as a dashboard; the same figures on a inset
 * surface read as one subject, and the card gets a third level -- page, card,
 * well -- for nothing but a background colour.
 */
function Traffic({ node }: { node: Node }) {
  const m = node.metrics
  const used = monthUsage(node)
  const limit = node.traffic_limit
  const pct = limit > 0 ? percent(used, limit) : null
  const mode = MODE_LABEL[node.traffic_mode] ?? "SUM"

  return (
    <div className="mt-3 rounded-lg border border-border-soft bg-card-2 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Glyph icon={Network} box="sm" />
          周期流量
        </span>
        {/* What the plan counts, and how much: `MAX 710 MB` is the figure the
            quota below is a share of, so it leads the bar rather than trailing
            it under a word. */}
        <span className="tnum flex items-baseline gap-1 text-2xs font-semibold">
          <span className="rounded-xs bg-brand/10 px-1 text-[0.625rem] font-semibold tracking-wide text-brand">{mode}</span>
          {bytes(used)}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-3">
        <Speed dir="rx" value={m ? rate(m.net_rx) : "—"} />
        <Speed dir="tx" value={m ? rate(m.net_tx) : "—"} />
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-rail">
          <div
            className={cn("h-full rounded-full bg-linear-to-r transition-[width] duration-500", quotaTone(pct))}
            style={{ width: `${pct === null ? 0 : Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        <span className="tnum shrink-0 text-2xs text-muted-foreground">
          {pct === null ? FOREVER : `${percentText(pct)} · ${bytes(limit)}`}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border-soft pt-1.5">
        <span className="text-2xs text-muted-foreground">连接</span>
        <span className="tnum shrink-0 text-2xs">
          {m ? `${m.tcp} TCP · ${m.udp} UDP · ${m.procs} 进程` : "—"}
        </span>
      </div>
      {/* The quota as a sentence for anyone who wants one: the bar is the same
          fact drawn, and a screen reader has nothing to look at. */}
      <span className="sr-only">{trafficFoot(node)}</span>
    </div>
  )
}

/** Whole days left, or null where nothing expires. */
function expiryDays(node: Node): number | null {
  return node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
}

/**
 * The foot of the card: what it costs, and how long that buys.
 *
 * One line, because they are one thought -- `年付 $6.75 · 剩 141 天` is a price
 * and its term, and a card that put them at opposite corners made the reader
 * join them. The currency is its symbol alone; zh-CN writes `US$`, which inside
 * a line of bare figures is two characters of noise. The count is the hub's,
 * which renews an online node by its own calendar.
 */
function Billing({ node }: { node: Node }) {
  const days = expiryDays(node)
  const { value } = moneyParts(node.price, node.currency, 2)
  const priced = node.price > 0
  const tone = days !== null && days < 0 ? "text-destructive" : days !== null && days <= 7 ? "text-warn" : "text-muted-foreground"
  if (!priced && days === null) return null

  return (
    <div className="mt-3 flex items-baseline justify-between gap-2 border-t border-border-soft pt-2.5 text-2xs">
      <span className="truncate text-muted-foreground">{priced ? cycle(node.billing_cycle) : "—"}</span>
      <span className="tnum flex shrink-0 items-baseline gap-1.5">
        {priced && (
          <span className="font-semibold text-foreground">
            <span className="font-medium text-muted-foreground">{moneyMark(node.currency)}</span>{value}
          </span>
        )}
        {priced && days !== null && <span aria-hidden className="text-border">·</span>}
        {days !== null && (
          <span className={tone} title={node.expires_at ?? undefined}>
            {days < 0 ? `已过期 ${-days} 天` : `剩 ${days} 天`}
          </span>
        )}
      </span>
    </div>
  )
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics
  // Load against the core count it competes for, so one number says whether the
  // machine has room. A load of 1.0 is idle on four cores and saturated on one.
  const loadPct = m && node.cpu_cores > 0 ? (m.load[0] / node.cpu_cores) * 100 : null
  const cpu = cpuName(node.cpu_name)

  return (
    <Card
      onClick={onOpen}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // OS line below does not wrap, so on a phone the card would grow past its
      // column and scroll the page sideways. The truncate inside only takes effect
      // once the card is allowed to be narrower.
      //
      // A card is a button here, so it draws the button's focus: the ring and the
      // border the pointer gets on hover, since a list walked with Tab otherwise
      // moves nothing on screen.
      className="min-w-0 cursor-pointer gap-0 p-3.5 outline-none transition-[box-shadow,border-color] duration-200 hover:border-ring/50 hover:shadow-raise focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      role="button"
      tabIndex={0}
      // Without a name of its own the card is announced as its whole subtree --
      // six figures and sixty coloured boxes -- so the accessible name is the two
      // facts a reader would say out loud.
      aria-label={`${node.name}，${statusLabel(node)}`}
      data-node={node.id}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className="flex items-center gap-2.5 border-b border-border-soft pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Country node={node} />
            {/* The dot follows the flag: it says of the machine what the flag
                says of the place, and the pair reads as one label. */}
            <span className={cn("size-1.5 shrink-0 rounded-full", statusDot(node))} title={statusLabel(node)} />
            <h3 className="truncate text-sm font-semibold" title={node.name}>{node.name}</h3>
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
            {node.os && <OsIcon os={node.os} />}
            <span className="truncate">
              {node.os
                ? [osName(node.os), node.virt !== "none" && node.virt, node.arch].filter(Boolean).join(" · ")
                : "等待首次上报"}
            </span>
          </p>
        </div>
        {/* One badge in the corner, and which one follows the state. */}
        {node.online ? <Uptime node={node} /> : deployed(node) ? <Offline /> : null}
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3.5">
            <Resource
              icon={Cpu}
              label="CPU"
              value={percentText(m ? m.cpu : null)}
              sub={[node.cpu_cores ? `${node.cpu_cores} 核` : "", cpu].filter(Boolean).join(" · ")}
              pct={m ? m.cpu : null}
              tone="from-blue-500 to-indigo-500"
            />
            <Resource
              icon={MemoryStick}
              label="内存"
              value={m ? percentText(percent(m.mem_used, m.mem_total)) : "—"}
              sub={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              tone="from-violet-500 to-purple-500"
            />
            <Resource
              icon={HardDrive}
              label="硬盘"
              value={m ? percentText(percent(m.disk_used, m.disk_total)) : "—"}
              sub={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              tone="from-amber-500 to-orange-500"
            />
            <Resource
              icon={Activity}
              label="负载"
              value={m ? m.load[0].toFixed(2) : "—"}
              sub={m ? `5m ${m.load[1].toFixed(2)} · 15m ${m.load[2].toFixed(2)}` : "—"}
              pct={loadPct}
              tone="from-pink-500 to-rose-400"
            />
          </div>

          <Traffic node={node} />

          {/* An offline node has no line to measure, and its last hour would be
              read as a live one. */}
          {node.online && <PingPanel node={node} />}

          <Billing node={node} />
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
