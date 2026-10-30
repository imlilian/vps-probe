import { useEffect, useId, useRef, useState } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import type { Node } from "@/lib/api"
import { clockFor } from "@/lib/format"
import {
  cardProbes, fmtLoss, fmtMs, HOURS, latencySignal, lossSignal, probeLatencySignal, qualitySignal, slotSignal,
  useNodePing, type ProbeStats, type Quality, type Slot,
} from "@/lib/ping"
import { cn } from "@/lib/utils"

/**
 * Six fills: no data, then the five steps. Tailwind palette steps rather than
 * literal colours -- the block is a fill, so it needs 3:1 against the card and
 * nothing more, while the figure beside it is text and takes a darker step of the
 * same hue (see [INK]).
 *
 * The ramp is emerald, green, lime, yellow, rose, and it climbs in hue as well as
 * in lightness so that a run of slow blocks is visibly a run rather than a
 * slightly different green. Only the last step is red: it means the line lost
 * most of a block, which is the one thing worth stopping on.
 */
const FILL = [
  "bg-muted",
  "bg-signal-1",
  "bg-signal-2",
  "bg-signal-3",
  "bg-signal-4",
  "bg-signal-5",
]

/**
 * The figure's ink. The two greens share a step of ink -- lime at 11px is a
 * highlight, not text -- so the words beside a strip read as a value and not as a
 * palette sample.
 */
const INK = [
  "text-muted-foreground",
  "text-emerald-700 dark:text-emerald-400",
  "text-emerald-700 dark:text-emerald-400",
  "text-amber-700 dark:text-amber-400",
  "text-orange-700 dark:text-orange-400",
  "text-red-700 dark:text-red-400",
]

/**
 * The quality strip's fills: what went wrong in a block, or nothing.
 *
 * Deliberately not the latency ramp. That one is a continuous scale where every
 * block is coloured and the colour says how far away the target was; this one
 * marks exceptions, because "clean" is the state almost every block is in and a
 * second full ladder beside the first would compete with it. A clean block is a
 * third of the way to the best green -- present, so the strip reads as twenty
 * blocks rather than as gaps, and quiet enough to be skipped by the eye.
 */
const QUALITY_FILL: Record<Quality, string> = {
  none: "bg-muted",
  clean: "bg-signal-1/35",
  retx: "bg-signal-4",
  lost: "bg-signal-5",
}

function slotTitle(slot: Slot, clock: (ms: number) => string) {
  if (!slot) return "无采样"
  const at = clock(slot.ts * 1000)
  if (slot.latency === null) return `${at} · 超时`
  return `${at} · ${fmtMs(slot.latency)} ms · 丢包 ${fmtLoss(slot.loss)}% · 重传 ${fmtLoss(slot.retx)}%`
}

/**
 * Twenty blocks, one per three minutes of the last hour.
 *
 * Four pixels tall rather than six. At six the strip was a bar -- a second block
 * of colour under the figures, competing with them for the eye -- and the whole
 * point of it is the reference theme's: at a glance down the page, which machine
 * is smooth and which is not. Four pixels of colour still says `mostly green,
 * one bad quarter of an hour`, and hands the height back to the numbers.
 *
 * One pixel of gap rather than two: two strips share the card's width now, and
 * the block count is fixed at twenty because that is the resolution -- three
 * minutes of the hour. Narrower blocks are the trade; fewer of them would be a
 * different claim about the hour.
 */
function Blocks({
  slots, clock, fill, className,
}: {
  slots: Slot[]
  clock: (ms: number) => string
  fill: (slot: Slot) => string
  className?: string
}) {
  return (
    // The figures above carry the reading; the strip is the same data drawn, so
    // a screen reader is spared twenty unlabelled boxes. The title on each block
    // is still there for a pointer, which is the only way to ask a block what it
    // was.
    <div className={cn("grid grid-cols-20 gap-px", className)} aria-hidden>
      {slots.map((slot, i) => (
        <span key={i} title={slotTitle(slot, clock)} className={cn("h-1 rounded-xs", fill(slot))} />
      ))}
    </div>
  )
}

/** The hour's latency, in the five-step ramp. */
function Strip({ slots, clock, className }: { slots: Slot[]; clock: (ms: number) => string; className?: string }) {
  return <Blocks slots={slots} clock={clock} fill={(slot) => FILL[slotSignal(slot)]} className={className} />
}

/** The same twenty blocks, judged for what went missing and whether it came back. */
function QualityStrip({ slots, clock, className }: { slots: Slot[]; clock: (ms: number) => string; className?: string }) {
  return <Blocks slots={slots} clock={clock} fill={(slot) => QUALITY_FILL[qualitySignal(slot)]} className={className} />
}

/**
 * `丢包% · 重传%`: the two figures the quality strip colours, in one column of
 * fixed width so the rows of a card line up. Amber ink for a retransmit at any
 * rate -- the block beside it is amber for the same reason, and there is no
 * second degree of "it came back".
 */
function QualityNums({ probe }: { probe: ProbeStats }) {
  return (
    <span className="tnum min-w-[4.5rem] shrink-0 text-right">
      <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
        {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
      </span>
      <span aria-hidden className="text-border"> · </span>
      <span className={cn("font-medium", INK[probe.retx ? 4 : 0])}>
        {probe.retx === null ? "—" : `${fmtLoss(probe.retx)}%`}
      </span>
    </span>
  )
}

/** What a screen reader hears for one probe: the name and the three figures. */
function spoken(probe: ProbeStats, quality: boolean) {
  const latency = probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} 毫秒` : "无读数"
  const loss = probe.loss === null ? "无样本" : `丢包 ${fmtLoss(probe.loss)}%`
  const retx = quality && probe.retx !== null ? `，重传 ${fmtLoss(probe.retx)}%` : ""
  return `${probe.name}，延迟 ${latency}，${loss}${retx}`
}

/**
 * One probe: the name, the reading of the last few minutes, the hour's loss, and
 * the hour drawn under them.
 *
 * The figure is a window's median rather than the newest sample -- see [RECENT]
 * in `lib/ping.ts` for why one lost packet must not turn the card into a
 * timeout.
 *
 * Three columns of these was the alternative -- the reference theme draws them
 * side by side -- and it does not survive this card's width: a third of 300px is
 * ten pixels a block, which shows a colour but never a run of them. Stacked, each
 * strip is as wide as the card and a bad quarter of an hour is a shape.
 */
/** Up to the next round number: 23 → 25, 345 → 400. The steps a chart's grid
 *  wants, so the ceiling never sits on the data or a third of a box above it. */
function niceTop(value: number): number {
  const power = 10 ** Math.floor(Math.log10(Math.max(1, value)))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * power) return step * power
  }
  return 10 * power
}

/**
 * The curve's ceiling, off the link's own figures: the worst sample with a
 * little air, or a third again over the median so a steady line sits in the
 * middle of the box rather than on its roof.
 *
 * The axis is local because the colour is not: the stroke and its fill are the
 * band the median falls in, chosen from the same five bands the blocks use, so
 * how good a link is read from the colour anywhere on the page, and the height is
 * free to answer the other question -- what the hour did.
 */
function curveTop(probe: ProbeStats): number {
  const worst = worstMs(probe) ?? 0
  const median = probe.typical ?? probe.reading ?? worst
  return niceTop(Math.max(worst * 1.15, median * 1.4, 15))
}

/** The highest answer in the window, for the line under the curve. */
function worstMs(probe: ProbeStats): number | null {
  const answered = probe.series.flatMap((r) => (r.latency === null ? [] : [r.latency]))
  return answered.length ? Math.max(...answered) : null
}

/** The lowest, beside it: `最佳` is the number that says how good this link gets. */
function bestMs(probe: ProbeStats): number | null {
  const answered = probe.series.flatMap((r) => (r.latency === null ? [] : [r.latency]))
  return answered.length ? Math.min(...answered) : null
}

/**
 * The hour in two words: 最佳 and 最差 -- the ends of the window, which is what the
 * row is for. `中位` was here and is gone: the figure above already *is* a median,
 * so a `中位 208 ms` beside it was one number said twice, and the row has only the
 * width of a card to say two things in.
 *
 * The edges of the data are the edges of this row: a window where nothing answered
 * has no best and no worst, and two dashes are two ways of saying `超时`. One
 * sentence takes their place.
 */
function stats(probe: ProbeStats): { label: string; ms: number | null }[] {
  return [
    { label: "最佳", ms: bestMs(probe) },
    { label: "最差", ms: worstMs(probe) },
  ]
}

/**
 * The line under a probe's figures: the hour's best and worst, each in the ink of
 * its own band, so `最差` climbing out of green is visible before it is read -- the
 * same scale the strip and the curve use.
 *
 * Two figures and not three, and no timestamp: the card's width is the constraint,
 * and "when did it last answer" is always a minute ago on a card that is being
 * watched, which is a fact the strip's right-hand edge already draws.
 */
function StatRow({ probe, className }: { probe: ProbeStats; className?: string }) {
  return (
    <div className={cn("tnum flex items-baseline justify-between gap-2 text-3xs text-muted-foreground", className)}>
      {worstMs(probe) === null ? (
        <span className="text-muted-foreground">超时，无响应</span>
      ) : (
        stats(probe).map(({ label, ms }) => (
          <span key={label}>
            {label} <span className={cn("font-medium", INK[latencySignal(ms)])}>{ms === null ? "—" : `${fmtMs(ms)} ms`}</span>
          </span>
        ))
      )}
    </div>
  )
}

/** The band a medium reading falls in: the colour of the curve and of its fill. */
function curveBand(probe: ProbeStats): number {
  return probeLatencySignal(probe) || latencySignal(probe.typical) || 1
}

/**
 * One probe's hour as a line, where three probes get twenty blocks each.
 *
 * A single probe is not one of a comparison -- it is a link to somewhere, on a
 * machine that only has that one line -- so the card spends the space on the
 * shape of the hour rather than on a row of blocks nobody would compare. Three
 * probes keep the blocks: twenty shared columns is what makes a fleet scannable.
 *
 * The line itself is grey and the *fill* carries the colour, mixed vertically
 * through the same five bands the blocks use: the fill under a spike is warm at
 * the spike and cool at its foot, so the colour still answers "how good is this
 * link" while the line answers "when". A line whose stroke changed colour along
 * its length would say neither cleanly.
 *
 * Where a bucket timed out the line breaks -- a gap is the honest drawing of no
 * sample -- and the hole is marked at the baseline in the loss colour, because a
 * gap in a grey line could as easily be a missing probe as a dead link.
 *
 * Drawn by hand rather than with the charting library the detail page uses: that
 * one is a 350 KB chunk this card's page deliberately does not load (see the
 * split in `App.tsx`), and a sparkline is a path and a gradient.
 */
function Curve({ probe, className }: { probe: ProbeStats; className?: string }) {
  // Unique per instance: an id shared by two cards on one page is one card's
  // gradient painted into the other.
  const id = `curve${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const band = curveBand(probe)
  const top = curveTop(probe)
  const W = 300
  const H = 100
  const span = Math.max(1, probe.until - probe.since)
  const x = (ts: number) => ((ts - probe.since) / span) * W
  // One pixel of inset top and bottom, so a zero or a ceiling answer is drawn
  // inside the box rather than clipped by its edge.
  const y = (latency: number) => H - 1 - (Math.min(latency, top) / top) * (H - 2)

  const runs: { x: number; y: number }[][] = []
  const gaps: [number, number][] = []
  let run: { x: number; y: number }[] = []
  let from: number | null = null
  for (const r of probe.series) {
    if (r.latency === null) {
      if (run.length) {
        runs.push(run)
        run = []
      }
      from ??= x(r.ts)
    } else {
      if (from !== null) {
        gaps.push([from, x(r.ts)])
        from = null
      }
      run.push({ x: x(r.ts), y: y(r.latency) })
    }
  }
  if (run.length) runs.push(run)
  if (from !== null) gaps.push([from, W])

  const path = (points: { x: number; y: number }[]) =>
    points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
  const area = (points: { x: number; y: number }[]) =>
    `${path(points)} L${points.at(-1)!.x.toFixed(1)} ${H} L${points[0].x.toFixed(1)} ${H} Z`

  return (
    // The box owns the height and the drawing fills it. An `<svg>` with a viewBox
    // has an intrinsic 3:1 ratio, and left to itself inside a flex column it takes
    // *that* as its height -- 93px at this width, which overflowed the well and
    // painted over the card's footer. `min-h-0` lets the wrapper be the height the
    // flex line gives it; `h-full` makes the drawing follow the wrapper rather than
    // its own ratio.
    <div className={cn("flex min-h-0", className)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        // One colour for the stroke and the fill: the band's ink, inherited by the
        // gradient's `currentColor`, so the shading cannot drift from the line.
        className={cn("block h-full w-full", INK[band])}
        aria-hidden
      >
      <defs>
        {/* `currentColor`: the same ink the stroke takes, so the shading under a
            link is that link's colour -- a paler token here read as grey against
            the well, which is the one thing it must not look like. */}
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "currentColor", stopOpacity: 0.34 }} />
          <stop offset="1" style={{ stopColor: "currentColor", stopOpacity: 0.03 }} />
        </linearGradient>
      </defs>
      {runs.map((points, i) =>
        points.length === 1 ? (
          <circle key={i} cx={points[0].x} cy={points[0].y} r={1.5} fill="currentColor" opacity={0.7} />
        ) : (
          <path key={i} d={area(points)} fill={`url(#${id})`} />
        ),
      )}
      {runs.map((points, i) =>
        points.length === 1 ? null : (
          <path
            key={i}
            d={path(points)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
      {gaps.map(([a, b], i) => (
        <path
          key={i}
          d={`M${a.toFixed(1)} ${H - 0.5} H${b.toFixed(1)}`}
          style={{ stroke: "var(--color-signal-5)" }}
          strokeWidth={1.5}
          strokeDasharray="2 2"
          opacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      </svg>
    </div>
  )
}

/**
 * The single-probe card: the same height as three probes, spent on one link.
 *
 * The name and its reading on top, the hour drawn below them, the quality strip
 * under the curve -- the same twenty blocks, at the card's full width, because
 * one link has the room and "when it went wrong" is the one thing the curve
 * cannot say -- and the four numbers that describe a link underneath. It is the
 * same well as a three-probe card's -- the card grid asks for one height for the
 * row -- so the curve grows into whatever room the row leaves.
 *
 * No column header: the curve is the subject here, and the figures at the bottom
 * name themselves.
 */
function Solo({ probe, hours, quality }: { probe: ProbeStats; hours: number; quality: boolean }) {
  const clock = clockFor(hours)
  const latency = probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} ms` : "—"
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      title={`${probe.name} · 近 ${hours} 小时的延迟${quality ? "、丢包与重传" : "与丢包"}`}
      aria-label={spoken(probe, quality)}
    >
      <div className="flex items-baseline justify-between gap-2 text-2xs">
        <span className="truncate font-medium text-muted-foreground">{probe.name}</span>
        <span className="tnum flex shrink-0 items-baseline gap-1.5">
          <span className={cn("font-semibold", INK[probeLatencySignal(probe)])}>{latency}</span>
          {/* One probe, no header: the loss figure stays beside the reading it
              belongs to, and the bottom row carries all four numbers when the
              hub reports retransmits. */}
          {!quality && (
            <>
              <span aria-hidden className="text-border">·</span>
              <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
                丢包 {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
              </span>
            </>
          )}
        </span>
      </div>
      <Curve probe={probe} className="mt-1.5 min-h-8 flex-1" />
      {quality && <QualityStrip slots={probe.slots} clock={clock} className="mt-1.5" />}
      {quality ? <SoloRow probe={probe} className="mt-1.5" /> : <StatRow probe={probe} className="mt-1.5" />}
    </div>
  )
}

/**
 * The four numbers under a solo curve: the ends of the hour, and the two
 * percentages that say how often it went wrong. `最佳 41 ms` / `最差 62 ms` /
 * `重传 2.1%` / `丢包 0%` fits 297px with room to spare.
 *
 * All-timeout keeps the one sentence: two dashes and two percentages are four
 * ways of saying the line is down, and the strip above is already rose end to
 * end.
 */
function SoloRow({ probe, className }: { probe: ProbeStats; className?: string }) {
  const worst = worstMs(probe)
  if (worst === null) return <StatRow probe={probe} className={className} />
  return (
    <div className={cn("tnum flex items-baseline justify-between gap-2 text-3xs text-muted-foreground", className)}>
      {stats(probe).map(({ label, ms }) => (
        <span key={label}>
          {label} <span className={cn("font-medium", INK[latencySignal(ms)])}>{ms === null ? "—" : `${fmtMs(ms)} ms`}</span>
        </span>
      ))}
      <span>
        重传 <span className={cn("font-medium", INK[probe.retx ? 4 : 0])}>
          {probe.retx === null ? "—" : `${fmtLoss(probe.retx)}%`}
        </span>
      </span>
      <span>
        丢包 <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
          {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
        </span>
      </span>
    </div>
  )
}

/**
 * The column header, over two or three probes only.
 *
 * It names what the two columns of figures are, in the same grid the rows use so
 * the words sit over the numbers they label. One probe has no header: the curve
 * is the subject and the four numbers at the bottom name themselves.
 *
 * Plain spans rather than `role="columnheader"`: this is not a table, and a
 * reader is handed the whole row as one sentence (see [spoken]).
 */
function Heads() {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 text-3xs text-muted-foreground">
      <span className="text-right">延迟</span>
      <span className="min-w-[4.5rem] text-right">丢包 · 重传</span>
    </div>
  )
}

/**
 * One probe of two or three: two rows, the figures above and the two strips
 * under them.
 *
 * The figures use `grid-cols-[1fr_auto]`: the name and its reading share the
 * left column (`justify-between`, the reading at its right edge) and the quality
 * column keeps a fixed width so `51 ms` in one row sits over `51 ms` in the next.
 * Under them `grid-cols-[3fr_2fr]` gives the latency strip three fifths and the
 * quality strip two: the latency strip is a bar to be scanned, the quality one a
 * line of markers, and markers need less room to say the same thing.
 */
function Probe({
  probe, hours, extra = false, quality,
}: {
  probe: ProbeStats
  hours: number
  extra?: boolean
  quality: boolean
}) {
  const clock = clockFor(hours)
  const latency = probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} ms` : "—"
  return (
    <div
      className="py-1 first:pt-0 last:pb-0"
      title={`${probe.name} · 近 ${hours} 小时的延迟${quality ? "、丢包与重传" : "与丢包"}`}
      aria-label={spoken(probe, quality)}
    >
      <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 text-2xs">
        <span className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate text-muted-foreground">{probe.name}</span>
          <span className={cn("tnum min-w-[3.25rem] shrink-0 text-right font-semibold", INK[probeLatencySignal(probe)])}>
            {latency}
          </span>
        </span>
        {quality ? (
          <QualityNums probe={probe} />
        ) : (
          <span className={cn("tnum min-w-[2.5rem] shrink-0 text-right font-medium", INK[lossSignal(probe.loss)])}>
            {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
          </span>
        )}
      </div>
      <div className={cn("mt-1 grid gap-2", quality ? "grid-cols-[3fr_2fr]" : "grid-cols-1")}>
        <Strip slots={probe.slots} clock={clock} />
        {quality && <QualityStrip slots={probe.slots} clock={clock} />}
      </div>
      {/* Two probes leave the room three do not, and a link is worth more than its
          last five minutes: the hour's median and its worst bucket are what tell
          `a steady 230 ms` from `230 ms with a cliff`. */}
      {extra && <StatRow probe={probe} className="mt-1" />}
    </div>
  )
}

/**
 * A node's probe history, once its element is nearly in view.
 *
 * A page below the fold asks nothing until it is nearly on screen. A hundred
 * nodes would otherwise queue a hundred history queries on load, two at a time,
 * and the three cards someone is looking at would wait behind all of them.
 */
function useLazyPing(node: Node, hours: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        setSeen(true)
        observer.disconnect()
      },
      { rootMargin: "200px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])

  return [ref, useNodePing(node.id, hours, seen)] as const
}

/**
 * The same hour for the compact card, as figures.
 *
 * No strip: at the 60-odd pixels a fourth of a compact card gives it, twenty
 * blocks are six pixels each, which shows a colour but never a run -- and a run
 * is the only thing a strip is better at than a number. Which probe and how bad
 * is one press away on the node's own page.
 */
export function ProbeLines({ node, hours = HOURS }: { node: Node; hours?: number }) {
  const [ref, entry] = useLazyPing(node, hours)
  const probes = entry?.data ? cardProbes(entry.data) : []
  if (entry && !probes.length) return null

  return (
    // Three lines' height, always: a node with one probe and a node with three are
    // the same card in a column of them, and the blanks are cheaper than a row of
    // cards with ragged middles. `cardProbes` caps the list at three, so this is a
    // floor, not a clip.
    <div ref={ref} className="mt-1.5 min-h-[3.25rem] space-y-0.5">
      {probes.length ? (
        probes.map((probe) => (
          <div
            key={probe.id}
            className="flex items-baseline justify-between gap-2 text-2xs"
            title={spoken(probe, probe.retxKnown)}
            aria-label={spoken(probe, probe.retxKnown)}
          >
            <span className="truncate text-muted-foreground">{probe.name}</span>
            <span className="tnum flex shrink-0 items-baseline gap-1.5">
              <span className={cn("font-semibold", INK[probeLatencySignal(probe)])}>
                {probe.timedOut ? "超时" : probe.reading !== null ? `${fmtMs(probe.reading)} ms` : "—"}
              </span>
              <span className={cn("font-medium", INK[lossSignal(probe.loss)])}>
                {probe.loss === null ? "—" : `${fmtLoss(probe.loss)}%`}
              </span>
              {/* A retransmit is a low-frequency exception, and this card has no
                  room for a second strip: one dot says "something came back
                  late in this hour", and the figure is in the title. Nothing at
                  all when the line was clean -- this line's layout must not
                  change on a healthy fleet. */}
              {probe.retx ? (
                <span className="ml-0.5 size-[3px] shrink-0 self-center rounded-full bg-signal-4" title={`重传 ${fmtLoss(probe.retx)}%`} />
              ) : null}
            </span>
          </div>
        ))
      ) : (
        <Skeleton aria-hidden className="h-3 w-full" />
      )}
    </div>
  )
}

/**
 * The bottom of a node card: the probes, one row each, inside the second of the
 * card's two wells.
 */
export function PingPanel({ node, hours = HOURS }: { node: Node; hours?: number }) {
  const [ref, entry] = useLazyPing(node, hours)
  // Recomputed on each render rather than memoised: the strip is twenty blocks
  // off at most sixty rows, and the window is aligned to the block grid, so a
  // push every two seconds produces the same blocks until a block rolls over.
  const probes = entry?.data ? cardProbes(entry.data) : []

  // Answered, and there is nothing to draw: the node has no probe configured.
  // The well goes with it -- a bordered box with 20px of nothing under it was the
  // bottom of every card on a fresh install. The frame belongs to the strips
  // inside, not to the absence of them.
  if (entry && !probes.length) return null

  // One probe is a different subject from three: a solo link is drawn as a line and
  // given the card's slack, where three keep the twenty-block strips that make a
  // fleet scannable. Both fill the well, so a row of cards stays one height --
  // `flex-1` here rather than a measured height constant, because the row already
  // tells this card how tall it must be.
  const solo = probes.length === 1
  // One answer for the whole card, so one flag decides for every probe on it: a
  // hub that does not produce the retransmit rate has no quality column at all
  // (the card keeps the layout it has today), where a hub answering zero has one
  // that reads 0%.
  const quality = probes[0]?.retxKnown ?? false

  return (
    // The well eats whatever the row leaves over, with a 124px floor.
    //
    // Not a fixed height. The old `h-[7.25rem]` wrote the row's height out as
    // "three rows of 24px plus their paddings plus two hairlines", so a fourth
    // line, a size step in the type or the header this release adds would push
    // the content over the footer with nothing to stop it. Every well in a row
    // gets the same height only if the height comes from the row: the three
    // blocks above this one (header lines, resource cells, traffic well) are the
    // same components with the same number of lines on every card, so what is
    // left over is the same number, and `flex-1` hands it to the well.
    //
    // The invariant, and it is load-bearing: everything above this well must stay
    // "the same components, a fixed number of lines per card". Give one of them a
    // line that appears only on some cards and the wells of that row stop
    // matching, silently.
    <div
      ref={ref}
      className="mt-2.5 flex min-h-31 flex-1 flex-col rounded-lg border border-border-soft bg-card-2 px-2.5 py-2"
    >
      {probes.length ? (
        solo ? (
          <Solo probe={probes[0]} hours={hours} quality={quality} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {quality && <Heads />}
            <div className="flex min-h-0 flex-1 flex-col justify-between divide-y divide-border-soft">
              {probes.map((probe) => (
                <Probe key={probe.id} probe={probe} hours={hours} extra={probes.length === 2} quality={quality} />
              ))}
            </div>
          </div>
        )
      ) : (
        // One row, not three. A placeholder that reserves the widest case and
        // then collapses on the answer pulls every card below it upward, which
        // is the jump it was meant to prevent; one row that grows pushes them
        // down instead, which reads as the content arriving rather than leaving.
        <div aria-hidden>
          <div className="flex justify-between gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="mt-1.5 h-1.5 w-full" />
        </div>
      )}
    </div>
  )
}
