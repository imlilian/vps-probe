/// <reference types="node" />
// Markup smoke test. There is no headless browser on the build machine, so the
// components are rendered through Vite's own pipeline and the output is read as
// text: this proves the module graph compiles and that the figures and labels a
// visitor depends on reach the page. Colour, spacing and the live stream are
// left to a browser -- `npm run dev:mock` with a person in front of it.
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { createServer } from "vite"

import type { Node } from "@/lib/api"

// `theme.ts` subscribes at module scope, and nothing on this machine has a
// system colour scheme to subscribe to.
Object.assign(globalThis, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
})

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" })
try {
  const { TopBar } = await server.ssrLoadModule("/src/components/TopBar.tsx")
  const bar = (props: Record<string, unknown>) =>
    renderToString(createElement(TopBar, {
      siteName: "测试站点", authed: false, error: null, closed: false,
      mode: "system", onMode() {}, onHome() {}, ...props,
    }))

  const live = bar({})
  for (const want of ["测试站点", "实时连接", "主题：跟随系统", "主题：明亮", "主题：深色", "/admin/", "登录"]) {
    assert.ok(live.includes(want), `missing ${want}`)
  }
  // The mark and the name, and nothing after them: `/ MONITOR` named the
  // software on a page whose only subject is the operator's own fleet.
  assert.ok(live.includes('src="/favicon.svg"'), "the mark sits in front of the name")
  // The name is the page's title: at 14px it was the same size as the words in the
  // pill beside it, and named nothing in particular.
  assert.match(live, /text-sm font-bold tracking-tight sm:text-lg/, "the site name is set as a title")
  assert.ok(!live.includes("text-lg font-bold tracking-tight\""), "and only where the bar has the room for it")
  assert.ok(!live.includes("MONITOR") && !live.includes("> / <"), "and nothing trails it")
  // The count of online nodes left the header for the summary: `7/9` in the
  // corner and `7 / 9` in a card forty pixels below are one fact twice.
  assert.ok(!live.includes("7/9"), "the header no longer counts the fleet")
  console.log("bar names the site, says the stream is live and links the panel")

  // The slider is three stops, each its own button, and exactly one of them is
  // pressed: a single cycling button has to be aimed at a state it does not show.
  assert.equal(live.match(/aria-pressed="true"/g)?.length, 1)
  assert.equal(live.match(/aria-pressed="false"/g)?.length, 2)
  assert.ok(bar({ mode: "light" }).includes('aria-pressed="true"') && bar({ mode: "light" }).includes("主题：明亮"))
  assert.ok(bar({ mode: "dark" }).includes("主题：深色"))
  console.log("the theme slider offers all three stops and marks one")

  // The footer: from what, and when. The address only appears when the hub sent
  // one -- a hub predating the field draws three items, not four with a hole.
  const { VisitorFooter } = await server.ssrLoadModule("/src/components/VisitorFooter.tsx")
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
  const footer = (props: Record<string, unknown>) =>
    renderToString(createElement(VisitorFooter, {
      ua: edge, today: new Date(2026, 9, 28), ...props,
    }))

  const withIp = footer({ ip: "2605:52c0:2:3de2:be24:11ab" })
  for (const want of ["Windows", "Edge", "2605:52c0:2:3de2:be24:11ab", "2026年10月28日"]) {
    assert.ok(withIp.includes(want), `missing ${want}`)
  }
  assert.ok(withIp.includes("<footer"), "it is a footer")
  // Edge carries `Chrome/`; only the order in `ua.ts` keeps this line honest.
  assert.ok(!withIp.includes("Chrome"), "Edge is not read as Chrome")
  assert.ok(footer({}).includes("2026年10月28日"), "the date survives without an address")
  assert.ok(!footer({}).includes("2605:"), "no address, no empty slot")
  // The visitor's own label went with the left-hand block: the page no longer
  // tells a reader who they are, only what they are reading it on.
  assert.ok(!withIp.includes("感谢访问") && !withIp.includes("访客"), "no self-description")
  assert.ok(withIp.includes("justify-center"), "one centred line, not two edges")
  console.log("the footer gives the system, the browser, the address and the day")

  // A broken stream says so on the pill, which is the only thing in the bar a
  // visitor can look at before the figures below.
  const stale = bar({ error: "实时数据中断，正在重新连接" })
  assert.ok(stale.includes("重新连接"), "a stale stream says it is reconnecting")
  assert.ok(stale.includes("bg-warn"), "and ambers its dot")
  assert.ok(stale.includes("实时数据中断"), "the reason belongs in the tooltip")
  assert.ok(bar({ closed: true }).includes("已断开"))
  assert.ok(bar({ closed: true }).includes("bg-offline"))
  console.log("a broken stream is visible without reading the page")

  // The card, rendered against the sample fleet: the figures a visitor reads
  // first, and the socket counts and price that used to sit nowhere.
  const { NodeCard } = await server.ssrLoadModule("/src/components/NodeCard.tsx")
  const { nodeList } = await server.ssrLoadModule("/dev/demoData.ts")
  const fleet = nodeList(1_790_000_000_000) as unknown as Node[]
  const card = (i: number) =>
    renderToString(createElement(NodeCard, { node: fleet[i], onOpen() {} }))

  const full = card(1)
  for (const want of ["香港-CN2-02", "负载", "周期流量", "TCP", "进程", "59.90"]) {
    assert.ok(full.includes(want), `missing ${want}`)
  }
  // The mark is its own element, a size down and a shade lighter: `¥29.90` in one
  // weight reads as a label, a mark beside a figure reads as a price.
  assert.match(full, /text-muted-foreground">¥<\/span><span>59\.90<\/span>/, "the mark stands beside the figure")
  // The foot is a price tag: the period rides on the amount as a suffix, and the
  // count is the only other thing on the line.
  assert.match(full, /text-muted-foreground">\/(?:<!-- -->)?月<\/span>/, "the period hangs off the price")
  assert.match(full, /剩 \d+ 天/)
  // The price sits under a hairline, so the air a one-probe card leaves above it
  // reads as the space above a footer rather than as a hole in the card: the
  // wrapper is what is pinned, and the rule belongs to the price.
  assert.ok(full.includes('class="mt-auto pt-2"'), "the footer is pinned to the card's bottom")
  assert.match(full, /border-t border-border-soft pt-2[^.]/, "and drawn under a hairline")
  assert.ok(!full.includes("月付<"), "no billing word in front of the amount")
  // The billed usage leads the quota it is a share of, tagged with the plan's
  // own counting rule rather than a sentence about it.
  assert.match(full, />SUM</)
  // Uptime is a capsule of two units and no verb: `在线 92 天 0 小时` was three
  // times the width and carried a zero nobody reads.
  assert.match(full, /\d+d \d+h|\d+h \d+m|\d+m/, "uptime reads 1d 3h")
  // The verb survives in the title and the accessible name, where it is read
  // rather than seen; on screen the capsule is two units and nothing else.
  assert.ok(!full.includes(">在线 "), "no verb beside the uptime")
  assert.ok(full.includes('title="在线 '), "but the reading keeps its words for a screen reader")
  // The latency panel mounts its own well and asks for history only once it is
  // near the viewport, so what the server can show is the placeholder -- which is
  // exactly the point: a card with a line behind it reserves the row.
  assert.ok(full.includes("rounded-lg border border-border-soft bg-card-2 px-2.5 py-2"), "the probe well is drawn")
  assert.ok(full.includes("mt-1.5 h-1.5 w-full"), "and its strip is reserved before the answer")
  // Throughput follows the socket rule: the figure at full weight, the unit a
  // step down, and the two directions in the colours they carry everywhere.
  assert.match(full, /text-sm font-semibold">[\d.]+<\/span><span class="shrink-0 text-2xs/)
  assert.match(full, /text-emerald-600 dark:text-emerald-400/)
  // A label is not half of its figure. `33 TCP · 6 UDP · 86 进程` set flat was
  // four numbers and four words in one grey run; the number keeps the ink and a
  // size, the word steps down and mutes.
  assert.match(full, /font-semibold text-foreground text-xs">\d+<\/span><span class="ml-1 text-2xs font-normal text-muted-foreground">TCP/, "the socket count leads")
  assert.match(full, /text-2xs font-normal text-muted-foreground">进程/, "and the process label follows its number")
  // One label over two kinds of count: `连接` named the sockets and left the
  // processes it sits beside unaccounted for. The icon is the detail page's.
  assert.ok(full.includes("连接与进程"), "the row is labelled for both of its counts")
  assert.ok(!full.includes(">连接<"), "and no longer for the sockets alone")
  // Same rule on the traffic figure and on the amount: a bare `48.0 GB` at one
  // weight reads as a word, not a quantity.
  assert.match(full, /font-semibold text-foreground text-xs">[\d.]+<\/span><span class="ml-1 text-2xs font-normal text-muted-foreground">GB/)
  // The three edges of the foot: free, no end date, and a term longer than a year.
  const free = renderToString(createElement(NodeCard, {
    node: { ...fleet[1], price: 0, expires_at: null, expires_in: undefined }, onOpen() {},
  }))
  assert.match(free, />免费<\/span><\/span><span[^>]*>·<\/span><span[^>]*>永久</, "免费 · 永久")
  const tri = renderToString(createElement(NodeCard, {
    node: { ...fleet[1], price: 168, currency: "USD", billing_cycle: "triennial" }, onOpen() {},
  }))
  assert.match(tri, />\$<\/span><span>168<\/span>/, "$168：符号单独成元素")
  assert.match(tri, /text-muted-foreground">\/(?:<!-- -->)?3年<\/span>/, "周期挂在金额后面")
  // A card is a div carrying role="button", so the focus ring the browser would
  // draw for a real button is ours to draw: without it, tabbing through the list
  // moves nothing on screen.
  assert.match(full, /class="[^"]*focus-visible:ring-3[^"]*"[^>]*role="button"/)
  console.log("a card carries its figures, its sockets and its price")

  // An offline node has no live line, and the hour it last reported would read
  // as current if the strip were drawn from it.
  assert.ok(!card(7).includes("grid-cols-20"))
  // A machine that has gone quiet is drawn behind a red hatch with a red edge,
  // and the badge beside its name says how long it has been gone: the figures on
  // the card are still true, only old, so the veil says "not now" rather than
  // hiding them. A card that is merely live wears neither.
  const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/<!-- -->/g, "").replace(/\s+/g, " ")
  const quiet = card(7)
  assert.ok(quiet.includes("offline-veil"), "离线的卡片盖一层斜纹")
  assert.match(quiet, /class="[^"]*border-destructive\/40[^"]*"[^>]*role="button"/, "离线的卡片边是红的")
  assert.match(words(quiet), /离线\s*·\s*\d+\s*(分钟|小时|天)/, "徽章里写着离线多久")
  // Online: neither the hatch nor the red edge, and the uptime capsule instead.
  assert.ok(!full.includes("offline-veil"), "在线的卡片没有斜纹")
  assert.ok(!/class="[^"]*border-destructive/.test(full), "在线的卡片边不是红的")
  // And no renewal date is drawn as no mark at all. It used to be a lone `∞`
  // whose meaning lived in a tooltip, in the column that squeezed the OS line.
  // Node 7 (上海-家宽) is the undated one; node 8 is also undated but has no
  // traffic quota, and its `0 B / ∞` is the meter's own mark, not this one.
  assert.ok(!card(6).includes("∞"), "an undated node leaves the corner empty")
  console.log("an offline card draws no latency strip")

  // The strip itself, with a history behind it. Effects never run under
  // renderToString, so the cache is filled the way the hook would fill it, from
  // the sample hub's own answer shape.
  const { fetchPing } = await server.ssrLoadModule("/src/lib/ping.ts")
  const { history } = await server.ssrLoadModule("/dev/demoData.ts")
  const asked = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify(history(2, "ping", 1, 60, Date.now())), {
      headers: { "content-type": "application/json" },
    })
  try {
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const strip = card(1)
    // Four pixels tall, not six, and two strips per probe since this hub reports
    // retransmits: three probes of twenty blocks each, twice.
    const blocks = strip.match(/h-1 rounded-xs/g)?.length ?? 0
    assert.equal(blocks, 120, `three probes, a latency strip and a quality strip each, got ${blocks}`)
    assert.equal(strip.match(/grid-cols-20/g)?.length, 6, "six strips of twenty blocks")
    // Twenty blocks per strip is the resolution, not a number that shrinks when
    // the card has to fit two strips: the gap goes from 2px to 1px instead.
    assert.equal(strip.match(/gap-px/g)?.length, 6, "the blocks gave up the gap, not the count")
    for (const want of ["上海电信", "上海联通", "上海移动", "ms"]) {
      assert.ok(strip.includes(want), `missing ${want}`)
    }
    // Colour is data, and it is now one of five tokens rather than a palette
    // step picked per line: a block means the same thing on every card.
    assert.ok(/bg-signal-[1-5]/.test(strip), "the blocks are the signal scale")
    // No column header: at this width it was 12px of words over figures whose
    // units already say what they are. Each figure sits over the bar it colours,
    // labelled in two or three Latin letters so a translation cannot overflow it.
    assert.ok(!strip.includes(">延迟<"), "no header row")
    assert.ok(strip.includes("LOSS "), "the loss figure is labelled where there was one")
    assert.ok(strip.includes("RTX "), "and the retransmit rate is always there")
    // One order everywhere: the retransmit rate first, the loss at the outer
    // edge, as the legend escalates and as the sentence above reads.
    assert.ok(words(strip).indexOf("RTX") < words(strip).indexOf("LOSS"), "mild before severe")
    assert.ok(!strip.includes("丢包 · 重传"), "and the header's words are gone")
    // Each probe is one sentence to a screen reader, because the strips above are
    // aria-hidden and twenty unlabelled boxes say nothing. The sentence follows
    // the printed order: mild before severe.
    assert.match(
      strip,
      /aria-label="上海移动，延迟 \d+(\.\d)? 毫秒，重传 \d+(\.\d)?%，丢包 \d+(\.\d)?%"/,
      "a probe row is spoken: name, latency, retransmit, loss",
    )
    // The quality strip marks exceptions only: a third-strength green where
    // nothing went wrong, amber where a handshake came back late, rose where one
    // did not come back at all. The demo's congested line supplies both.
    assert.ok(strip.includes("bg-signal-1/35"), "a clean block is a quiet green")
    assert.ok(strip.includes("bg-signal-4"), "a retransmit is amber")
    // The quality strip's one green is the muted tint of a clean block -- no
    // second ladder of `bg-signal-2/3` beside the latency strip. Most blocks are
    // clean, and not all of them: the demo's congested line is what the two
    // exception fills are drawn from.
    const clean = strip.match(/bg-signal-1\/35/g)?.length ?? 0
    assert.ok(clean > 30 && clean < 60, `most quality blocks clean, got ${clean} of 60`)
    // The block's tooltip carries the two figures, so a pointer can ask.
    assert.match(strip, /title="[^"]*丢包 \d+(\.\d)?% · 重传 \d+(\.\d)?%"/)
  } finally {
    globalThis.fetch = asked
  }
  // One probe or three, the compact card's probe block is the same height.
  {
    const { ProbeLines } = await server.ssrLoadModule("/src/components/PingPanel.tsx")
    const block = renderToString(createElement(ProbeLines, { node: fleet[1] }))
    assert.ok(block.includes("min-h-[3.25rem]"), "three lines reserved, whatever the probe count")
    // The compact card now speaks the same vocabulary as the big one: no strip
    // (the card already carries four resource cells and two rates), but the
    // retransmit rate as a figure where an amber dot used to stand.
    const compact = block.replace(/<!-- -->/g, "")
    assert.match(compact, /RTX \d+(\.\d)?%/, "the retransmit rate is printed")
    assert.ok(!compact.includes("grid-cols-20"), "and still no strip")
    assert.ok(!compact.includes("size-[3px]"), "the amber dot is gone: the number is shorter")
  }
  console.log("a card with a history draws three strips of twenty blocks")

  // One probe is not one third of a comparison: it is a machine with a single link,
  // so the card draws the hour as a line and spends the room three probes do not
  // have on the numbers that describe a link. Two probes keep the strips and gain a
  // second line of figures.
  //
  // These two answers carry no `retx` map: that is a hub from before the metric,
  // and the card has to keep the shape it has today -- one strip per probe, the
  // loss figure beside the reading, no quality column anywhere.
  const row = (task: number, ts: number, latency: number | null, retx?: number) =>
    retx === undefined ? { task_id: task, ts, latency } : { task_id: task, ts, latency, retx }
  const served = (probes: Record<string, string>, tasks: number[], retxed = false) => {
    const newest = Math.ceil(Date.now() / 1000 / 60) * 60
    const ping = tasks.flatMap((task) =>
      Array.from({ length: 40 }, (_, i) =>
        // Every fifth bucket of the first probe came back only after the kernel's
        // retransmit, which is what draws an amber block.
        retxed && task === tasks[0] && i % 5 === 3
          ? row(task, newest - (39 - i) * 90, 200 + task * 10, 100)
          : row(task, newest - (39 - i) * 90, i % 13 === 5 ? null : 200 + task * 10 + (i % 7) * 5),
      ),
    )
    const answer: Record<string, unknown> = { ping, probes, loss: Object.fromEntries(tasks.map((t) => [t, 3.4])) }
    if (retxed) answer.retx = Object.fromEntries(tasks.map((t) => [t, 4.7]))
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } })
  }

  globalThis.fetch = async () => served({ "9": "上海电信" }, [9])
  try {
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const solo = card(1)
    assert.ok(solo.includes("上海电信"), "the one probe is named")
    assert.match(solo, /<svg[^>]*viewBox="0 0 300 100"/, "and drawn as a line")
    // One hue for the stroke and its fill -- the band the reading falls in -- shaded
    // from the line down to the axis.
    assert.ok(solo.includes("linearGradient"), "whose fill is shaded to the axis")
    // One colour for the line and its fill: `currentColor`, set once on the svg,
    // so the shading cannot drift from the stroke.
    assert.equal(solo.match(/stop-color:currentColor/g)?.length, 2, "one hue, two stops")
    assert.match(solo, /<svg[^>]*class="[^"]*text-(emerald|amber|orange|red)-700/, "the svg carries the band's ink")
    // Two figures, the ends of the hour: the median is already the number above
    // them, and a timestamp on a card being watched says nothing.
    for (const want of ["MIN", "MAX"]) {
      assert.ok(solo.includes(want), `a solo link says ${want}`)
    }
    for (const gone of ["最近", "中位", "最佳", "最差"]) {
      assert.ok(!solo.includes(gone), `a solo link no longer says ${gone}`)
    }
    // And each figure is set in its own band's ink, so a bad `最差` is coloured
    // before it is read.
    assert.ok((solo.match(/text-(emerald|amber|orange|red)-700 dark:text-\1-400">\d/g)?.length ?? 0) >= 3,
      "the figures carry the scale, the two under the curve included")
    assert.ok(!solo.includes("grid-cols-20"), "and drops the twenty blocks")
    // A hub that reports no retransmit rate gets no quality strip: the card is
    // exactly what it was before this release.
    assert.ok(!solo.includes("bg-signal-1/35"), "no quality strip without the figure")
    assert.ok(!solo.includes("RTX"), "and no retransmit figure either")
    // One height for all three probe counts: three rows of 24 and the 8px
    // between them is 88px, two rows carrying MIN/MAX come to the same, and the
    // 16px of padding makes 104.
    assert.ok(solo.includes("mt-2.5 flex h-31 flex-col"), "the well is 124px, whatever the probe count")
    assert.ok(!solo.includes("min-h-31"), "and no longer grows with the row")
  } finally {
    globalThis.fetch = asked
  }

  globalThis.fetch = async () => served({ "8": "上海电信", "9": "上海联通" }, [8, 9])
  try {
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pair = card(1)
    assert.ok(pair.includes("上海电信") && pair.includes("上海联通"), "both probes are named")
    assert.ok(pair.includes("h-31"), "and the well is the same fixed box")
    assert.equal(pair.match(/grid-cols-20/g)?.length, 2, "two probes keep two strips")
    assert.ok(!pair.includes("linearGradient"), "and no curve: two rows of blocks stay scannable")
    for (const want of ["MIN", "MAX"]) {
      assert.ok(pair.includes(want), `two probes can afford ${want}`)
    }
    // Without a quality column the MIN/MAX row has the whole width to itself, as
    // it always had.
    assert.equal(pair.match(/mt-1 grid gap-2"/g)?.length, 2, "MIN/MAX spans the card on an old hub")
  } finally {
    globalThis.fetch = asked
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // The same two layouts from a hub that does report retransmits: one probe keeps
  // its curve and gains a quality strip across the card's full width plus the
  // fourth figure in its bottom row; two probes get a strip each and a header.
  globalThis.fetch = async () => served({ "9": "上海电信" }, [9], true)
  try {
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const solo = card(1)
    assert.ok(solo.includes("linearGradient"), "the curve is still the subject")
    assert.equal(solo.match(/grid-cols-20/g)?.length, 1, "one strip, at the card's full width")
    assert.ok(solo.includes("bg-signal-1/35"), "and it is the quality strip")
    assert.ok(solo.match(/bg-signal-4/g), "with an amber block where a handshake came back late")
    for (const want of ["MIN", "MAX", "RTX", "LOSS"]) {
      assert.ok(solo.includes(want), `a solo link's bottom row says ${want}`)
    }
    assert.ok(!solo.includes(">延迟<"), "no column header on a one-probe card")
    // The two figures are in the bottom row here, and a figure that measured
    // nothing prints a dash rather than a zero.
    assert.match(words(solo), /RTX [\d.]+%/, "the bottom row carries the retransmit rate")
    assert.match(words(solo), /LOSS [\d.]+%/, "beside the loss")
    // The colour of the strip's blocks and the figure above are the same reading.
    assert.match(solo, /aria-label="上海电信，延迟 [^"]*，重传 [^"]*，丢包 [^"]*"/)
  } finally {
    globalThis.fetch = asked
  }

  globalThis.fetch = async () => served({ "8": "上海电信", "9": "上海联通" }, [8, 9], true)
  try {
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pair = card(1)
    assert.equal(pair.match(/grid-cols-20/g)?.length, 4, "two probes, two strips each")
    // Both rows use one grid, so each figure sits over the bar it colours: the
    // reading at the right of the latency column, LOSS and RTX at the two ends of
    // the quality one.
    // An even split, both rows: the quality column has to hold `LOSS 99.9%` and
    // `RTX 99.9%` side by side, and three fifths left it tight at a third of that.
    assert.equal(pair.match(/grid-cols-2 items-baseline/g)?.length, 2, "each reading row splits evenly")
    assert.equal(
      pair.match(/mt-1 grid gap-2 grid-cols-2"><div class="grid gap-px/g)?.length, 2,
      "and each strip row with it",
    )
    assert.ok(pair.includes("LOSS ") && pair.includes("RTX "), "the two labels sit over their strip")
    assert.ok(pair.includes("h-31"), "and the well is the one fixed height")
    // MIN and MAX stay in the latency column: they are the ends of that strip, and
    // a MAX at the card's right edge read as the quality strip's own range.
    assert.equal(pair.match(/grid-cols-2"><div class="tnum flex/g)?.length, 2,
      "each MIN/MAX row stays under its own strip")
  } finally {
    globalThis.fetch = asked
    fetchPing(2)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log("one probe draws the hour as a line, two keep the blocks and gain figures")

  // A node with no probe configured answers with an empty `probes`, and the panel
  // keeps its frame and its padding under nothing: a bordered well across the
  // bottom of every card, on a fresh install, with no way to see it in the demo
  // (all eight sample nodes carry probes).
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ping: [], probes: {} }), { headers: { "content-type": "application/json" } })
  try {
    fetchPing(3)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(!card(2).includes("grid-cols-20"), "no probes leaves no frame")
    assert.ok(card(2).includes("周期流量"), "and the rest of the card is untouched")
    // The compact card is the other half of the same answer.
    const { ProbeLines } = await server.ssrLoadModule("/src/components/PingPanel.tsx")
    assert.ok(!renderToString(createElement(ProbeLines, { node: fleet[2] })).includes("ms"))
  } finally {
    globalThis.fetch = asked
    // Put node 3's real history back: the empty answer above was for one card.
    fetchPing(3)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log("a node without probes keeps no empty frame at the bottom")

  // A node whose agent never connected: the list leaves it out (`serving`), so
  // what a hub that still sends one gets is this. It has to speak to a visitor,
  // in the card's own language -- the sentence that used to sit here told the
  // reader to go and run an install command in the panel.
  const never = { ...fleet[1], online: false, metrics: null, cpu_cores: 0, mem_total: 0, os: "", arch: "" }
  const unplugged = renderToString(createElement(NodeCard, { node: never as Node, onOpen() {} }))
  for (const want of ["尚未接入监控", "接入后显示资源与流量"]) {
    assert.ok(unplugged.includes(want), `a never-connected node says ${want}`)
  }
  assert.ok(unplugged.includes("等待首次上报"), "and the line under its name still says what is missing")
  assert.ok(!unplugged.includes("在后台"), "and no longer sends a visitor to the panel")
  console.log("a node that never reported is drawn as a state, not as a sentence")

  // The overview row: five tiles, one question each, and the bill to schedule in
  // the last one.
  const { Overview } = await server.ssrLoadModule("/src/components/Overview.tsx")
  const overview = renderToString(createElement(Overview, { nodes: fleet }))
  for (const want of ["节点", "最忙节点", "实时速率", "今日流量", "剩余价值", "0 点起"]) {
    assert.ok(overview.includes(want), `missing ${want}`)
  }
  // One size for the five labels, and it is a title's: 11px beside a 16px glyph
  // read as a caption, which is what the figure below it already had one of.
  assert.equal(overview.match(/text-sm font-medium text-muted-foreground/g)?.length, 5,
    "every tile labels itself at the same size")
  // Seven of the eight sample nodes are up. React separates two text children
  // with a comment, so the pair is matched rather than searched for; the total
  // is set a step down, since a total is a unit and not a second count.
  assert.match(overview, /7<span[^>]*text-base[^>]*>\/ <!-- -->8/)
  // Two sample nodes are inside the month, so the row has to say a bill is
  // coming rather than that nothing is.
  assert.match(overview, /台 30 天内到期/)
  assert.ok(!overview.includes("无近期到期"))
  // The peak is drawn at the same precision as the meter it came from: `46.2%`
  // here against the card's `46%`, one screen apart, reads as two machines.
  assert.match(overview, /text-2xl font-bold leading-8 tracking-tight">\d+%/, "the peak has no decimal")
  // An expired machine is not one "due within 30 days" -- it is already dark --
  // and adding the two counts makes a third fact that is false.
  const overdue = fleet.map((n, i) => (i === 1 ? { ...n, expires_in: -3, expires_at: "2026-10-20T00:00:00Z" } : n))
  const withExpired = renderToString(createElement(Overview, { nodes: overdue }))
  assert.ok(withExpired.includes("1 台已过期"), "the expired node is counted on its own")
  assert.ok(!withExpired.includes("2 台 30 天内到期"), "and not folded into the 30-day count")
  // The two flow tiles pin their rows to the bottom of the fixed box: 14px rows
  // under an 18px label read as a caption glued to the title, so the slack the
  // box already had is given back as air above the first row instead.
  assert.equal(overview.match(/class="mt-auto"/g)?.length, 2, "the two flow bodies sit at the bottom")
  // A tile is not a link, but it answers the pointer: five of them, one rule.
  assert.equal(overview.match(/hover:-translate-y-0\.5/g)?.length, 5, "every tile lifts on hover")
  // Two flow tiles, four rows: the arrow and its two letters, then the figure.
  assert.equal(overview.match(/>RX</g)?.length, 2, "one RX row per flow tile")
  assert.equal(overview.match(/>TX</g)?.length, 2, "and one TX")
  // Every unit in those rows is set a step down from its figure, which is what
  // keeps "39.6 MB/s" from reading as one word.
  assert.match(overview, /text-2xs font-normal text-muted-foreground">MB\/s</)
  // The estimate is drawn in dollars whatever the machines are billed in, and
  // the dollar is drawn as `$`, the way the yuan is drawn as `¥`.
  assert.match(overview, /text-muted-foreground">\$<\/span>/)
  // One height for every tile, whatever it holds: the box is what gives the
  // figure its air, and a traffic card with no note must not be shorter.
  assert.equal(overview.match(/min-h-29/g)?.length, 5)
  // Five into two columns is one cell over, so the last tile takes the row rather
  // than leaving half a card of paper beside it.
  assert.match(overview, /col-span-2 sm:col-span-1[^>]*>[\s\S]*剩余价值/)
  console.log("the overview counts the fleet, the peak, the two flows and the bill")

  // The toolbar: one control per question, each of them a real control. Ten keys
  // plus 默认, both densities drawn as icons, and the pressed state on exactly
  // one of each -- the chips' and the density pair's -- so nothing is a
  // `<div onClick>`.
  const { Toolbar } = await server.ssrLoadModule("/src/components/Toolbar.tsx")
  const { SORTS } = await server.ssrLoadModule("/src/lib/sort.ts")
  const toolbar = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(Toolbar, {
      nodes: fleet, found: fleet, shown: fleet.length, group: null, onGroup() {},
      order: { key: "operator", dir: "asc" }, onOrder() {}, density: "standard", onDensity() {},
      query: "", onQuery() {}, ...props,
    }))

  const controls = toolbar()
  assert.equal(controls.match(/<option/g)?.length, SORTS.length)
  assert.match(controls, /<select[^>]*aria-label="排序"/, "the order is a native select")
  assert.match(controls, /aria-label="[^"]*升序；按下改为降序"/, "the arrow says which way it points")
  assert.equal(controls.match(/aria-pressed="true"/g)?.length, 2, "one chip and one density, pressed")
  // The density is two icons: `标准` and `紧凑` were the widest labels in the
  // row and the least informative.
  assert.ok(controls.includes('aria-label="标准卡片"') && controls.includes('aria-label="紧凑卡片"'))
  assert.ok(!controls.includes(">标准<"), "the density carries no words")
  // The search is a button until someone wants it: a field that is always open
  // spends 150px of a toolbar to do nothing.
  // The same words as the field it becomes: a screen reader should not have to
  // learn a second name for the thing it just opened.
  assert.ok(controls.includes('aria-label="搜索节点名称"'))
  assert.ok(!controls.includes('type="search"'), "no field until the button is pressed")
  // The sample fleet has six groups, so the tabs are drawn; 全部 counts all eight.
  for (const want of ["全部", "香港", "日本", "美国", "新加坡", "欧洲", "国内", "未分组"]) {
    assert.ok(controls.includes(want), `missing ${want}`)
  }
  assert.ok(!controls.includes("8 台"), "nothing is filtered, so the count is on the 全部 tab and nowhere else")
  // Narrowed: the count says so, and the order does too.
  const narrowed = toolbar({ group: "香港", shown: 2 })
  assert.equal(narrowed.match(/aria-pressed="true"/g)?.length, 2)
  assert.ok(narrowed.includes("2 / 8 台"))
  // The chips count what the search left, not the fleet: with `香港` typed the
  // Tokyo tab says nothing and stops taking presses, so no chip opens on an
  // empty page.
  const hkOnly = fleet.filter((n) => n.group === "香港")
  const searching = toolbar({ found: hkOnly, query: "香港", shown: 2 })
  assert.match(searching, /<button[^>]*disabled=""[^>]*>日本<span[^>]*>0<\/span>/, "an emptied tab is inert")
  assert.match(searching, /<button(?![^>]*disabled="")[^>]*>香港<span[^>]*>2<\/span>/, "the matching one still opens")
  console.log("the toolbar offers groups, ten orders, two densities and a search")

  // Group, search and order together: the tab narrows the list, the search
  // narrows the tab, the order decides what is left, and none undoes another.
  const { NodeList } = await server.ssrLoadModule("/src/App.tsx")
  const list = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(NodeList, {
      nodes: fleet, group: null, query: "",
      order: { key: "operator", dir: "asc" }, density: "standard",
      onGroup() {}, onQuery() {}, onOrder() {}, onDensity() {}, onOpen() {}, ...props,
    }))

  // Read from the grid down: the summary above the list names the busiest node,
  // so `indexOf` over the whole page would find that name before the list even
  // starts and call the order right for the wrong reason.
  const cards = (html: string) => html.slice(html.indexOf("sm:grid-cols-2 lg:grid-cols-3"))
  const hongKong = cards(list({ group: "香港", order: { key: "cpu", dir: "desc" } }))
  const first = hongKong.indexOf("香港-CN2-02") // 47% on four cores
  const second = hongKong.indexOf("香港-CN2-01") // 18% on two
  assert.ok(first >= 0 && second > first, "the busier of the two Hong Kong nodes leads")
  assert.ok(!hongKong.includes("东京-BGP-01"), "the tab keeps the rest of the fleet out")
  const reversed = cards(list({ group: "香港", order: { key: "cpu", dir: "asc" } }))
  assert.ok(reversed.indexOf("香港-CN2-01") < reversed.indexOf("香港-CN2-02"), "the arrow reverses it")
  // Ordering by name reaches across the whole fleet when no tab is chosen.
  const whole = list({ order: { key: "name", dir: "asc" } })
  const byName = cards(whole)
  assert.ok(byName.indexOf("东京-BGP-01") < byName.indexOf("香港-CN2-01"))
  // The search narrows within the tab and leaves the rest of the tab alone.
  const searched = cards(list({ query: "香港" }))
  assert.ok(searched.includes("香港-CN2-01") && searched.includes("香港-CN2-02"))
  assert.ok(!searched.includes("东京-BGP-01"), "the search keeps the rest of the fleet out")
  assert.ok(!cards(list({ query: "不存在的机器" })).includes("香港"), "nothing matches, nothing is drawn")
  // The summary comes first and follows the filters; the controls sit between it
  // and the cards.
  assert.ok(whole.indexOf("最忙节点") < whole.indexOf('aria-label="排序"'), "the summary leads the controls")
  assert.ok(whole.indexOf('aria-label="排序"') < whole.indexOf("sm:grid-cols-2 lg:grid-cols-3"))
  assert.ok(whole.includes("最忙节点"), "the five tiles are always drawn")
  // One height per row in the standard density too: a node with one probe used to
  // end two rows short of its neighbour, its price at a third height.
  assert.ok(whole.includes("grid items-stretch"), "a row of cards is one height")
  console.log("a group narrows the list, a search narrows the group, the order arranges what is left")

  // The compact card: the same node in a quarter of the height. It keeps the four
  // readings the standard card has -- so a scan does not depend on the sort -- and
  // drops the two wells.
  const compactHtml = list({ density: "compact" })
  const compactCards = cards(compactHtml)
  // Both densities stretch their rows to one height -- see App.tsx -- and the
  // compact ones sit closer together.
  assert.ok(compactHtml.includes("grid items-stretch") && compactCards.includes("gap-2"),
    "compact cards sit closer together")
  assert.ok(compactCards.includes("香港-CN2-02"), "a compact card still names the node")
  assert.ok(compactCards.includes("59.90"), "and still shows what it costs")
  for (const want of ["CPU", "内存", "硬盘", "负载"]) {
    assert.ok(compactCards.includes(`>${want}<`), `a compact card keeps ${want}`)
  }
  // Out of a compact card: the cycle-traffic well, the sockets and the strips.
  for (const dropped of ["周期流量", "连接", "grid-cols-20"]) {
    assert.ok(!compactCards.includes(dropped), `a compact card leaves out ${dropped}`)
  }
  // The compact card is a card like any other: the offline hatch is drawn on it,
  // the price is pinned to the bottom of the row, and the probe lines reserve three
  // lines whether the node has one probe or three.
  const { NodeRow } = await server.ssrLoadModule("/src/components/NodeRow.tsx")
  const rowHtml = (node: Node) => renderToString(createElement(NodeRow, { node, onOpen() {} }))
  const darker = rowHtml({ ...fleet[1], online: false })
  assert.ok(darker.includes("offline-veil"), "an offline row carries the hatch")
  assert.ok(darker.includes("relative") && darker.includes("overflow-hidden"), "in a box that clips it")
  assert.ok(!rowHtml(fleet[1]).includes("offline-veil"), "a reporting row carries none")
  assert.ok(compactCards.includes('class="mt-auto pt-2"'), "and the price is pinned to the bottom")
  console.log("the compact card keeps four readings and drops the wells")

  // The detail page's shell: who the machine is, what it is, and which views it
  // offers. Its charts need effects and a viewport, so what is asserted here is
  // everything above them -- and the one field that must not be here at all.
  const { NodeDetail } = await server.ssrLoadModule("/src/components/NodeDetail.tsx")
  const detail = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(NodeDetail, {
      node: fleet[1], historyDays: 7, onBack() {}, ...props,
    }))

  const page = detail()
  // Sixteen figures: the price, the four live resources, what is queued, and
  // what the machine has moved. The labels are the contract; the formatting is
  // asserted on the few that have a non-obvious unit.
  for (const label of [
    "节点价格", "月均支出", "剩余时间", "剩余价值",
    "CPU 使用率", "内存使用率", "交换内存", "硬盘使用率",
    "系统负载", "进程数", "连接数", "运行时间",
    "实时上行", "实时下行", "累计流量", "流量配额",
  ]) {
    assert.ok(page.includes(`text-muted-foreground">${label}</span>`), `missing the ${label} card`)
  }
  for (const title of ["硬件信息", "系统信息", "存储信息", "网络信息"]) {
    assert.ok(page.includes(`>${title}</h3>`), `missing the ${title} card`)
  }
  // Three tokens, not one string: the mark as a unit, the figure at the tile's
  // scale, and the period the price buys trailing behind it.
  assert.match(page, /text-\[0\.7em\][^"]*">¥<\/span><span>59\.90<\/span>/, "the mark is a unit beside the price")
  assert.match(page, /[^"]*text-2xs[^"]*">\/ 月<\/span>/, "the period follows the price")
  assert.ok(page.includes("<span>13.79</span>"), "remaining value is prorated in the node's currency")
  assert.match(page, />7<\/span><span class="[^"]*text-2xs[^"]*">天<\/span>/, "seven days left")
  assert.ok(page.includes("CPU Mark"), "the CPU's public benchmark is one link away")
  assert.ok(page.includes("高端服务器级"), "EPYC 7B13 is an A/consumer-context server tier")
  // React separates a text child from an expression with a comment.
  assert.match(page, /agent <!-- -->1\.4\.2/)
  assert.match(page, /aria-label="返回全部节点"/, "the way back is an icon button")
  assert.match(page, /aria-label="切换节点"/, "and the fleet switcher is a select")
  assert.ok(page.includes(">在线<"), "the state is one word")
  assert.ok(!page.includes(">在线 9"), "and the uptime is not glued to it")
  // Three controls are on: the load range, the latency range and 全选. The
  // star, the live chip, the other ranges, the 全不选 and the 削峰 chip are off.
  assert.equal(page.match(/aria-pressed="true"/g)?.length, 3, "load range + latency range + 全选")
  assert.equal(page.match(/aria-pressed="false"/g)?.length, 10, "star + live + other ranges + 全不选 + 削峰")
  // A public page never shows where the machine is: an operator's `ip` and
  // `hostname` are the panel's.
  const hidden = detail({ node: { ...fleet[1], ip: "203.0.113.7", hostname: "hk-02" } })
  assert.ok(!hidden.includes("203.0.113.7"), "the address stays in the panel")
  assert.ok(!hidden.includes("hk-02"), "and so does the hostname")
  // The note written for visitors, and only that one: `remark` is the panel's
  // own, and this page must not be the place that could publish it.
  assert.ok(page.includes("上海移动方向近期丢包偏高"), "the public note reaches the visitor")
  const panelNote = detail({ node: { ...fleet[1], public_remark: "", remark: "恢复密码在 1Password" } })
  assert.ok(!panelNote.includes("恢复密码在 1Password"), "a panel note never reaches the page")
  // No renewal date is words on the page rather than `∞`.
  const undated = detail({ node: { ...fleet[1], expires_at: null, expires_in: null } })
  assert.ok(undated.includes("永久"), "an undated machine says so in words")
  // Free, no cap and no swap are three different absences.
  const freeNode = detail({ node: { ...fleet[1], price: 0, billing_cycle: "once" } })
  assert.ok(freeNode.includes("免费"), "a free machine says 免费")
  assert.ok(freeNode.includes("无"), "and has no remaining value")
  const uncapped = detail({ node: { ...fleet[1], traffic_limit: 0 } })
  assert.ok(uncapped.includes("∞"), "no traffic cap is infinity")
  const noSwap = detail({ node: { ...fleet[1], swap_total: 0, metrics: { ...fleet[1]!.metrics!, swap_total: 0 } } })
  assert.ok(noSwap.includes("没有 Swap"), "a machine without swap says so in the tooltip")
  // The flag is the node's identity here, as on the card.
  assert.match(page, /alt="HK"/)
  console.log("the detail page names the machine, shows sixteen figures and hides its address")

  // The load grid: six panels over one hub answer. The headers and legends are
  // what SSR can prove; the measured plot needs a browser.
  const { LoadCharts } = await server.ssrLoadModule("/src/components/detail/LoadCharts.tsx")
  const loadRows = history(2, "metrics", 6, 60, 1_790_000_000_000).metrics
  const load = renderToString(createElement(LoadCharts, {
    node: fleet[1], rows: loadRows, hours: 6, smooth: false,
  }))
  for (const want of ["CPU", "内存与 Swap", "磁盘", "实时网络", "网络连接", "进程"]) {
    assert.ok(load.includes(`>${want}</h3>`), `missing the ${want} panel`)
  }
  for (const want of ["RAM 总量", "Swap 总量", "下载峰值", "上传峰值", "TCP", "UDP"]) {
    assert.ok(load.includes(want), `missing the ${want} legend`)
  }
  assert.equal(load.match(/data-slot="card"/g)?.length, 6, "six load panels")
  console.log("the load grid draws six panels with their legends")

  // A price on its own, in the four spellings the foot of a card can be asked
  // for. SSR cannot measure the sizes; it can prove that the mark is a separate
  // element, that the locale's prefix survives, and that a free machine has no
  // mark at all -- the three things the layout depends on.
  const { Billing } = await server.ssrLoadModule("/src/components/Billing.tsx")
  const foot = (over: Record<string, unknown>) =>
    renderToString(createElement(Billing, {
      node: { name: "x", billing_cycle: "monthly", expires_in: 212, ...over },
      size: "md",
    }))
  const cny = foot({ price: 29.9, currency: "CNY" })
  assert.match(cny, />¥<\/span><span>29\.90<\/span>/, "人民币的符号单独一个元素")
  assert.ok(!cny.includes(">¥29.90<"), "符号不跟数字粘在一起")
  assert.match(cny, />\/(?:<!-- -->)月<\/span>/, "周期跟在数字后面")
  const usd = foot({ price: 168, currency: "USD", billing_cycle: "yearly" })
  assert.match(usd, />\$<\/span><span>168<\/span>/, "美元跟人民币一样，只用符号")
  const hkd = foot({ price: 168, currency: "HKD" })
  assert.match(hkd, />HK\$<\/span><span>168<\/span>/, "港币留 HK，跟美元分得开")
  assert.match(foot({ price: 12.5, currency: "GBP" }), />£<\/span><span>12\.50<\/span>/, "英镑的符号")
  const unpriced = foot({ price: 0 })
  assert.ok(unpriced.includes("<span>免费</span>"), "免费就是免费，没有符号")
  assert.ok(!unpriced.includes("¥"), "免费不带任何货币符号")
  // A word is not a figure: at the size of the numbers beside it, `免费` read a
  // fifth larger than they did, because a CJK glyph fills its em box where a
  // digit reaches about seven tenths of one.
  assert.match(unpriced, /font-semibold text-foreground text-sm[^>]*>/, "免费 is set a step down from a price")
  assert.match(cny, /font-semibold text-foreground text-base[^>]*>/, "a figure keeps its size")
  console.log("a price keeps its mark as a unit beside the figure")

  console.log("the detail page composes header, figures, info, load and latency")

  // The detail page's probe card and its quality card, rendered on their own: the
  // section around them defers its request until it is scrolled into view, which
  // a server render never is.
  {
    const { ProbeCard } = await server.ssrLoadModule("/src/components/detail/LatencySection.tsx")
    const stat = {
      id: 1, name: "上海电信", avg: 51.4, latest: 53, min: 40, max: 62, p50: 51, p99: 62,
      volatility: 1.21, loss: 0, retx: 2.1, samples: 60, valid: 59,
    }
    // Server markup carries `<!-- -->` between adjacent text nodes; the figures
    // are asserted on the text a reader would see.
    const tidy = (html: string) => html.replace(/<!-- -->/g, "")
    const card = tidy(renderToString(createElement(ProbeCard, { stat, color: "#22c55e", on: true, onClick() {} })))
    // Two rows, three figures: the ones a reader acts on, then how often it went
    // wrong. `波动` moved into the ⓘ with the rest of the statistics.
    assert.ok(card.includes("AVG 51 ms"), "the card leads with the average")
    // MIN and MAX, not P50/P99: the chart below is titled 延迟 already, and a
    // public page should not ask a visitor to know what a percentile is. The
    // percentiles stay in the ⓘ.
    assert.ok(card.includes("MIN 40 ms / MAX 62 ms"), "and the window's two ends beside it")
    // The percentiles survive in the tooltip and the spoken label, which are
    // attributes; the row a visitor reads carries none.
    assert.ok(!card.replace(/<[^>]+>/g, "").includes("P50"), "no percentile on the row itself")
    assert.ok(card.includes("RTX 2.1%"), "then the retransmit rate")
    // A loss of zero is not printed at all: the retransmit rate always is, and
    // the strip beside the figures is what says whether anything went missing.
    assert.ok(!card.includes("LOSS"), "a clean window spends no column on a dash")
    assert.ok(!card.includes("LOSS 0%"), "and certainly not on a zero")
    // A line that did lose handshakes prints both, in the card's order.
    const lossy = tidy(renderToString(createElement(ProbeCard, {
      stat: { ...stat, loss: 33 }, color: "#22c55e", on: true, onClick() {},
    })))
    assert.ok(lossy.includes("RTX 2.1%") && lossy.includes("LOSS 33%"), "both figures when both happened")
    assert.ok(lossy.indexOf("RTX") < lossy.indexOf("LOSS"), "retransmit first")
    assert.ok(!card.includes("波动 1.21"), "the spread is in the tooltip, not the row")
    assert.match(card, /aria-label="上海电信，已显示；延迟 51 ms，P50 51 ms，P99 62 ms，重传 2.1%，丢包 0%，样本 60"/)
    // A hub without the figure: one row fewer, and no invented zero.
    const old = tidy(renderToString(createElement(ProbeCard, {
      stat: { ...stat, retx: null }, color: "#22c55e", on: false, onClick() {},
    })))
    assert.ok(!old.includes("RTX"), "no retransmit figure without it")
    assert.ok(!old.includes("LOSS"), "and no loss figure on a clean window either")
    assert.ok(old.includes("opacity-30"), "a hidden probe is dimmed")

    const { QualitySection } = await server.ssrLoadModule("/src/components/detail/QualitySection.tsx")
    const newest = Math.ceil(Date.now() / 1000 / 60) * 60
    const points = (task: number, retx?: number) =>
      Array.from({ length: 60 }, (_, i) => ({
        task_id: task,
        ts: (newest - (59 - i) * 60) * 1000,
        latency: i % 11 === 4 ? null : 40 + task,
        ...(i % 7 === 3 && retx ? { retx: 100 } : {}),
      }))
    const quality = tidy(renderToString(createElement(QualitySection, {
      series: [
        { id: 1, name: "上海电信", points: points(1, 1), loss: 3.3, retx: 4.7 },
        { id: 2, name: "上海联通", points: points(2), loss: 0, retx: 0 },
      ],
      hidden: [2],
      hours: 1,
    })))
    assert.ok(quality.includes("线路质量"), "the quality card is titled")
    // The block length is the window's, and the title says which.
    assert.ok(quality.includes("每块 3 分钟 · 首包重传与丢包"), "the block length is stated")
    assert.ok(quality.includes("LOSS 3.3%") && quality.includes("RTX 4.7%"), "each row carries both figures")
    assert.ok(quality.indexOf("RTX 4.7%") < quality.indexOf("LOSS 3.3%"), "retransmit before loss")
    // The second probe lost nothing, so its row names no loss at all.
    assert.equal(quality.match(/LOSS /g)?.length, 1, "a clean line prints no loss figure")
    // One row per probe, at the window's block count: an hour is twenty blocks of
    // three minutes, and the strip is a template rather than the card's twenty
    // fixed columns.
    assert.equal(quality.match(/repeat\(20, minmax\(0, 1fr\)\)/g)?.length, 2, "twenty blocks per probe")
    assert.equal(quality.match(/h-1 rounded-xs/g)?.length, 40, "two strips of twenty")
    // Amber where a handshake came back late, clean green where nothing did, and
    // the four legend entries under the rows.
    assert.ok(quality.includes("bg-signal-4"), "a retransmitted block is amber")
    assert.ok(quality.includes("bg-signal-1/35"), "and a clean one is a quiet green")
    for (const want of ["干净", "重传", "丢包", "无采样"]) {
      assert.ok(quality.includes(want), `the legend names ${want}`)
    }
    // The explanation of the two metrics exists exactly once, in this card's ⓘ.
    assert.match(quality, /aria-label="延迟是首包往返时间[^"]*3 秒内连不上/)
    assert.ok(quality.includes("opacity-30"), "a hidden probe is dimmed, not dropped")
    console.log("the detail page splits a probe into three figures, and draws quality as blocks")
  }
} finally {
  await server.close()
}
