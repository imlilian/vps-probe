import type { ReactNode } from "react"
import { Activity, CalendarClock, Gauge, Server, Wallet, type LucideIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { FlowTag } from "@/components/Flow"
import { Glyph } from "@/components/ui/glyph"
import { percentText } from "@/components/Meter"
import type { Node } from "@/lib/api"
import { bytes, moneyMark, moneyParts, rate, splitUnit } from "@/lib/format"
import { RATES_AS_OF } from "@/lib/rates"
import { busiest, due, fleet, live, residual, today, type Due } from "@/lib/stats"
import { cn } from "@/lib/utils"

/** Every figure on this row is drawn in it: see lib/rates.ts. */
const VALUED_IN = "USD"

/**
 * The body position for the two flow tiles: pinned to the bottom of the fixed
 * box, so the 8px a 24px figure's line box would leave over becomes 20px of air
 * between the title and the first row -- measured, in a 116px card with a 14px
 * inset and an 18px label.
 *
 * A constant because it is a measurement, not a style: if the card's height or
 * the label's line box changes, this is the line to look at.
 */
const FLOW_BODY = "mt-auto"

function Tile({ icon, label, meta, note, body, className, children }: {
  icon: LucideIcon
  label: string
  /** What the label does not need to say because a short figure can: `合计`. */
  meta?: ReactNode
  /** The line under the body, pinned to the bottom. */
  note?: ReactNode
  /**
   * How the body sits under the label. `mt-2` by default, which is what a 24px
   * figure wants: its own line box already leaves 4px above the glyph. The two
   * flow tiles pass `mt-auto` instead -- their rows are 14px, so the same 8px
   * gap reads as a caption glued to the title, and pinning them to the bottom of
   * the fixed box gives that space back between the label and the first row.
   */
  body?: string
  /** Where the tile sits in the grid; five into two columns leaves one cell over. */
  className?: string
  children: ReactNode
}) {
  return (
    // One height for all five: 14 + 18 (label) + 8 + 32 (figure) + 8 + 16
    // (note) + 14, and 8 more of air. Auto-height made every tile shrink to its
    // own content, so a two-row traffic table and a single percentage sat in
    // boxes of different shapes and the shortest one read as crowded; the fixed
    // box is what lets the same figure breathe in all of them. The extra 8 is
    // for the two flow tiles, whose rows are 14px against everyone else's 24:
    // `mt-auto` turns it into the space under their titles.
    //
    // The card is not a link and does not pretend to be one, but it still
    // answers the pointer: the hairline steps up a shade and the card lifts two
    // pixels onto its raised shadow. Not a scale -- a scaled box resamples the
    // text inside it and 12px numerals turn soft -- and not the ring the
    // clickable node cards use, which would promise somewhere to go.
    <Card
      className={cn(
        "@container flex min-h-29 flex-col gap-0 p-3.5 transition-[box-shadow,border-color,translate] duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-raise",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Glyph icon={icon} />
        <span className="min-w-0 truncate">{label}</span>
        {meta && <span className="ml-auto shrink-0 text-2xs opacity-80">{meta}</span>}
      </div>
      <div className={body ?? "mt-2"}>{children}</div>
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
  return <div className="tnum text-2xl font-bold leading-8 tracking-tight">{children}</div>
}

/**
 * The line under it: what the figure is made of, or what to do about it. `mt-auto`
 * pins it to the bottom of the fixed box, so five cards of unequal content line
 * up along it.
 */
function Note({ children, tone, title }: { children: ReactNode; tone?: string; title?: string }) {
  return (
    <div title={title} className={cn("mt-auto truncate text-2xs", tone ?? "text-muted-foreground")}>
      {children}
    </div>
  )
}

/**
 * The estimate, split: the mark as a unit, the amount as the figure. The mark is
 * the symbol alone -- `US$795` spends two characters of a narrow card saying what
 * `$795` says, and the currency of an estimate is already in the tooltip.
 */
function Money({ amount, currency }: { amount: number; currency: string }) {
  const { value } = moneyParts(amount, currency, 0)
  return (
    <Big>
      <span className="mr-1 text-base font-medium text-muted-foreground">{moneyMark(currency)}</span>
      {value}
    </Big>
  )
}

/**
 * One direction of a flow card: the shared label, then the figure with its unit
 * a step down.
 *
 * RX/TX rather than 入站/出站, and the colours emerald down and blue up -- see
 * FlowTag, where both are written once for the whole page.
 */
function Flow({ dir, text }: { dir: "rx" | "tx"; text: string }) {
  const [value, unit] = splitUnit(text)
  return (
    <>
      <FlowTag dir={dir} className="gap-1 tracking-wide" />
      <span className="tnum whitespace-nowrap text-right text-sm font-semibold">
        {value}
        {unit && <span className="ml-1 text-2xs font-normal text-muted-foreground">{unit}</span>}
      </span>
    </>
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
 * Five tiles, not seven: what is running, what is busiest, what the line is
 * doing now, what it has moved since midnight, and what the remaining time is
 * worth. CPU and memory aggregates were dropped -- one busy machine is the
 * signal, and a fleet average hides it -- and so was the cumulative byte total,
 * which every node resets on its own billing date and so grows without ever
 * describing a period.
 *
 * Two flow tiles rather than one table of four figures. The table was the
 * densest thing on the page -- four figures and two units inside a phone's
 * 130px -- and it made the reader hold two time scopes in their head to compare
 * one column. Split, each tile answers one question, and the same pair of rows
 * in both keeps them comparable at a glance.
 */
export function Overview({ nodes }: { nodes: Node[] }) {
  const { total, online, offline } = fleet(nodes)
  const top = busiest(nodes)
  const day = today(nodes)
  const now = live(nodes)
  const worth = residual(nodes)
  const ending = expiry(due(nodes))

  return (
    <div className="grid grid-cols-2 items-stretch gap-3 sm:grid-cols-3 lg:grid-cols-5">
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

      <Tile icon={Gauge} label="实时速率" body={FLOW_BODY}>
        {/* No note: two rows are the whole card, and the box is already a fixed
            height, so there is nothing left to prop up. The rows take the spare
            space as air above them instead of a footnote nobody needed. */}
        <div className="grid w-full grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-2.5">
          <Flow dir="rx" text={rate(now.rx)} />
          <Flow dir="tx" text={rate(now.tx)} />
        </div>
      </Tile>

      <Tile icon={CalendarClock} label="今日流量" meta="0 点起" body={FLOW_BODY}>
        <div className="grid w-full grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-2.5">
          <Flow dir="rx" text={bytes(day.rx)} />
          <Flow dir="tx" text={bytes(day.tx)} />
        </div>
      </Tile>

      <Tile
        icon={Wallet}
        label="剩余价值"
        // The odd one of five: at two columns it takes the whole row rather than
        // leaving half a card of paper beside it.
        className="col-span-2 sm:col-span-1"
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
