import type { CSSProperties, ReactNode } from "react"
import { Activity, Clock, Cpu, HardDrive, MemoryStick, Network, Plug, WifiOff, type LucideIcon } from "lucide-react"
import {
  siAlmalinux, siAlpinelinux, siArchlinux, siCentos, siDebian, siFedora, siLinux, siOpensuse, siRedhat,
  siRockylinux, siUbuntu, type SimpleIcon,
} from "simple-icons"

import { Badge } from "@/components/ui/badge"
import { Billing } from "@/components/Billing"
import { Card } from "@/components/ui/card"
import { FlowTag } from "@/components/Flow"
import { Glyph } from "@/components/ui/glyph"
import { percentText, RESOURCE_TONES } from "@/components/Meter"
import { deployed, monthUsage } from "@/lib/stats"
import { PingPanel } from "@/components/PingPanel"
import type { Node } from "@/lib/api"
import {
  absence, bytes, cpuName, FOREVER, osName, pair, percent, rate, sinceSeen,
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

/** `MAX`/`SUM`/`UP`/`DOWN`: how the plan counts, in the width of a tag. */
const MODE_LABEL: Record<string, string> = { up: "UP", down: "DOWN", max: "MAX", sum: "SUM" }

/**
 * How long the machine has been up, or once it is gone, how long it has been
 * absent -- the first question asked of an offline node.
 *
 * Exported with [statusDot] below: the compact card draws the same state as a
 * bare dot, and the two must not disagree about which of the three it is.
 */
export function statusLabel(node: Node): string {
  return node.online
    ? `在线 ${node.metrics ? uptimeShort(node.metrics.uptime) : ""}`.trim()
    : deployed(node)
      ? ["离线", absence(sinceSeen(node))].filter(Boolean).join(" ")
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
export function OsMark({ os, className }: { os: string; className?: string }) {
  const name = os.toLowerCase()
  const icon = DISTROS.find(([key]) => name.includes(key))?.[1] ?? siLinux
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      style={{ "--brand": `#${icon.hex}` } as CSSProperties}
      className={cn("shrink-0 distro-mark", className ?? "size-3")}
    >
      <title>{osName(os)}</title>
      <path d={icon.path} />
    </svg>
  )
}

function OsIcon({ os }: { os: string }) {
  return <OsMark os={os} />
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
 * for as long as it lasts -- how long is the first question the word raises, and
 * the answer is the figure the hatch has no room for. Under a minute the count
 * is left off rather than printed as `0 分钟`.
 */
function Offline({ node }: { node: Node }) {
  const down = absence(sinceSeen(node))
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-2xs font-semibold text-destructive">
      <Glyph icon={WifiOff} box="sm" />
      离线
      {down && (
        <>
          <span aria-hidden className="opacity-50">·</span>
          <span className="tnum font-medium">{down}</span>
        </>
      )}
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
 * A figure and the label that names it: `48.0` at full weight, `GB` a size down
 * and in the muted ink.
 *
 * The unit is not part of the number. Set at the same weight and colour it made
 * `33 TCP · 6 UDP · 86 进程` a run of grey text where four of the six tokens are
 * labels, and `48.0 GB` a word rather than a quantity -- the eye has nothing to
 * land on. Half a size and one step of ink is enough to separate them, and it
 * keeps the rows their present height.
 *
 * `size` picks the figure's step; the unit is always `text-2xs`, which is the
 * smallest text this page has.
 *
 * It sets no size on its own wrapper, so it takes its line box from the row it
 * sits in -- and a row that mixes a word with figures has to state the size on
 * both halves. Without it the figures inherit the card's 14px/20px text, their
 * box comes out taller than the word's, and centring the two halves lines the
 * text up on nothing: that is the tilt the sockets row was reported with.
 */
export function Figure({ text, size = "sm", className, title }: {
  text: string
  /** `lg` is for the metric row, where the figure is the thing read first. */
  size?: "lg" | "sm" | "xs"
  className?: string
  title?: string
}) {
  const [figure, unit] = splitUnit(text)
  return (
    <span className={cn("tnum whitespace-nowrap", className)} title={title}>
      <span className={cn("font-semibold text-foreground", size === "lg" ? "text-lg leading-none" : size === "sm" ? "text-sm" : "text-xs")}>{figure}</span>
      {unit && <span className="ml-1 text-2xs font-normal text-muted-foreground">{unit}</span>}
    </span>
  )
}

/**
 * Throughput in one direction: the shared label, then the figure with the unit
 * a step down.
 *
 * RX/TX rather than 入站/出站 -- see FlowTag. The two directions keep the
 * colours they have everywhere else on the page, emerald down and blue up, so
 * the traffic block and the tile above it are read the same way.
 */
function Speed({ dir, value }: { dir: "rx" | "tx"; value: string }) {
  const [figure, unit] = splitUnit(value)
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <FlowTag dir={dir} />
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
      {/* Centred rather than baseline-aligned, and so is the sockets row at the
          bottom of this well: a glyph has no baseline, so a row that starts with
          one aligns on the icon's bottom edge and the words float above the
          figures beside them. See the note there. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Glyph icon={Network} box="sm" />
          周期流量
        </span>
        {/* What the plan counts, and how much: `MAX 710 MB` is the figure the
            quota below is a share of, so it leads the bar rather than trailing
            it under a word. */}
        <span className="flex items-center gap-1 text-xs">
          <span className="rounded-xs bg-brand/10 px-1 text-3xs font-semibold tracking-wide text-brand">{mode}</span>
          <Figure text={bytes(used)} size="xs" />
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

      {/* Sockets and processes, under one label: the row carries two counts of
          two different things, and `连接` named only the first. The icon is the
          one the detail page gives `连接数`, so the same figure is marked the
          same way in both places.

          Both sides are 12px on purpose, and each side says so. The value half used
          to carry no size of its own, so it inherited the card's 14px/20px text:
          its box was taller than the label's and, centred against it, the figures
          sat a couple of pixels low -- which is the tilt this row was reported
          with. A glyph cannot join a baseline group either, so both halves are
          centred boxes now, and centred only agrees when both boxes are the same
          size to begin with. */}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border-soft pt-1.5">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Glyph icon={Plug} box="sm" />
          连接与进程
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs">
          {m ? (
            <>
              <Figure text={`${m.tcp} TCP`} size="xs" />
              <span aria-hidden className="text-2xs text-border">·</span>
              <Figure text={`${m.udp} UDP`} size="xs" />
              <span aria-hidden className="text-2xs text-border">·</span>
              <Figure text={`${m.procs} 进程`} size="xs" />
            </>
          ) : (
            <span className="text-2xs">—</span>
          )}
        </span>
      </div>
      {/* The quota as a sentence for anyone who wants one: the bar is the same
          fact drawn, and a screen reader has nothing to look at. */}
      <span className="sr-only">{trafficFoot(node)}</span>
    </div>
  )
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics
  // Load against the core count it competes for, so one number says whether the
  // machine has room. A load of 1.0 is idle on four cores and saturated on one.
  const loadPct = m && node.cpu_cores > 0 ? (m.load[0] / node.cpu_cores) * 100 : null
  const cpu = cpuName(node.cpu_name)
  // Gone, as opposed to never arrived: the second has nothing behind it to keep.
  const offline = !node.online && deployed(node)

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
      //
      // A card whose node has gone quiet keeps a red edge under the pointer, so
      // hover cannot make it look live, and carries the hatch drawn at the end of
      // this component. `relative` + `overflow-hidden` clip that veil to the
      // rounded corner; the focus ring is the card's own shadow, which neither
      // clips.
      className={cn(
        "relative min-w-0 cursor-pointer gap-0 overflow-hidden p-3.5 outline-none transition-[box-shadow,border-color] duration-200 hover:shadow-raise focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        offline ? "border-destructive/40 hover:border-destructive/60" : "hover:border-ring/50",
      )}
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
        {node.online ? <Uptime node={node} /> : deployed(node) ? <Offline node={node} /> : null}
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
              tone={RESOURCE_TONES.cpu}
            />
            <Resource
              icon={MemoryStick}
              label="内存"
              value={m ? percentText(percent(m.mem_used, m.mem_total)) : "—"}
              sub={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              tone={RESOURCE_TONES.mem}
            />
            <Resource
              icon={HardDrive}
              label="硬盘"
              value={m ? percentText(percent(m.disk_used, m.disk_total)) : "—"}
              sub={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              tone={RESOURCE_TONES.disk}
            />
            <Resource
              icon={Activity}
              label="负载"
              value={m ? m.load[0].toFixed(2) : "—"}
              sub={m ? `5m ${m.load[1].toFixed(2)} · 15m ${m.load[2].toFixed(2)}` : "—"}
              pct={loadPct}
              tone={RESOURCE_TONES.load}
            />
          </div>

          <Traffic node={node} />

          {/* An offline node has no line to measure, and its last hour would be
              read as a live one. */}
          {node.online && <PingPanel node={node} />}

          {/* The footer: a hairline and the price, pinned to the card's bottom.
              Pinned because the probe list above runs to as many rows as the node
              has probes, so a one-probe card would otherwise end two rows higher
              than its neighbour; and ruled because the air that this pinning
              leaves above it is otherwise a hole in the card -- the hairline makes
              it the space above a footer, which is what it is.

              The wrapper carries the `mt-auto` and the inner element the rule, so
              that a card with no slack to give keeps an 8px gap above the line
              instead of letting it touch the well above. Both gaps are 8 where they
              were 12 and 10, and the price is a step down at `size="sm"`: a footer
              is reference information, and it was reading as the loudest line on
              the card. */}
          <div className="mt-auto pt-2">
            <Billing node={node} className="border-t border-border-soft pt-2" size="sm" />
          </div>
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. The list leaves such a node out
           altogether -- see `serving` -- so this is what a hub that still sends
           one gets: a block on the card's own inset surface, in the card's own
           labels, rather than a sentence loose in the box saying something that
           only meant anything to whoever runs the panel. */
        <div className="mt-3 flex items-center gap-2.5 rounded-lg border border-dashed border-border-soft bg-card-2 p-2.5">
          <Glyph icon={WifiOff} box="lg" className="text-muted-foreground/60" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">尚未接入监控</p>
            <p className="mt-0.5 truncate text-2xs text-muted-foreground/80">接入后显示资源与流量</p>
          </div>
        </div>
      )}

      {/* Last, so it paints over the figures: the veil is the state, not a
          backdrop. Not announced -- the badge already says it in words. */}
      {offline && <span aria-hidden className="offline-veil pointer-events-none absolute inset-0" />}
    </Card>
  )
}
