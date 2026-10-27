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
  for (const want of ["测试站点", "MONITOR", "实时连接", "主题：跟随系统", "主题：明亮", "主题：深色", "/admin/", "登录"]) {
    assert.ok(live.includes(want), `missing ${want}`)
  }
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

  // The footer: who is reading, from what, and when. The address only appears
  // when the hub sent one -- a hub predating the field draws four items, not
  // five with a hole.
  const { VisitorFooter } = await server.ssrLoadModule("/src/components/VisitorFooter.tsx")
  const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
  const footer = (props: Record<string, unknown>) =>
    renderToString(createElement(VisitorFooter, {
      authed: false, ua: edge, today: new Date(2026, 9, 28), ...props,
    }))

  const withIp = footer({ ip: "2605:52c0:2:3de2:be24:11ab" })
  for (const want of ["访客", "感谢访问", "Windows", "Edge", "2605:52c0:2:3de2:be24:11ab", "2026年10月28日"]) {
    assert.ok(withIp.includes(want), `missing ${want}`)
  }
  assert.ok(withIp.includes("<footer"), "it is a footer")
  // Edge carries `Chrome/`; only the order in `ua.ts` keeps this line honest.
  assert.ok(!withIp.includes("Chrome"), "Edge is not read as Chrome")
  assert.ok(footer({}).includes("2026年10月28日"), "the date survives without an address")
  assert.ok(!footer({}).includes("2605:"), "no address, no empty slot")
  assert.ok(footer({ authed: true }).includes("管理员"), "a signed-in reader is named as one")
  console.log("the footer names the reader, the system, the browser and the day")

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
  // `US$` and `JP¥`: the locale's two extra characters are what a card column
  // cannot spare, and the mark alone is the price.
  assert.ok(!full.includes("US$"), "the currency is its symbol alone")
  // The foot is a price tag: the period rides on the amount as a suffix, and the
  // count is the only other thing on the line.
  assert.match(full, />¥(?:<!-- -->)?59\.90<span[^>]*>\/(?:<!-- -->)?月<\/span>/, "the period hangs off the price")
  assert.match(full, /剩 \d+ 天/)
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
  // Same rule on the traffic figure and on the amount: a bare `48.0 GB` at one
  // weight reads as a word, not a quantity.
  assert.match(full, /font-semibold text-foreground text-xs">[\d.]+<\/span><span class="ml-1 text-2xs font-normal text-muted-foreground">GB/)
  // The three edges of the foot: free, no end date, and a term longer than a year.
  const free = renderToString(createElement(NodeCard, {
    node: { ...fleet[1], price: 0, expires_at: null, expires_in: undefined }, onOpen() {},
  }))
  assert.match(free, />免费<\/span><span[^>]*>·<\/span><span[^>]*>永久</, "免费 · 永久")
  const tri = renderToString(createElement(NodeCard, {
    node: { ...fleet[1], price: 168, currency: "USD", billing_cycle: "triennial" }, onOpen() {},
  }))
  assert.match(tri, />\$(?:<!-- -->)?168<span[^>]*>\/(?:<!-- -->)?3年<\/span>/, "$168/3年")
  // A card is a div carrying role="button", so the focus ring the browser would
  // draw for a real button is ours to draw: without it, tabbing through the list
  // moves nothing on screen.
  assert.match(full, /class="[^"]*focus-visible:ring-3[^"]*"[^>]*role="button"/)
  console.log("a card carries its figures, its sockets and its price")

  // An offline node has no live line, and the hour it last reported would read
  // as current if the strip were drawn from it.
  assert.ok(!card(7).includes("grid-cols-20"))
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
    const blocks = strip.match(/h-1\.5 rounded-xs/g)?.length ?? 0
    assert.equal(blocks, 60, `three probes of twenty blocks, got ${blocks}`)
    for (const want of ["上海电信", "上海联通", "上海移动", "ms"]) {
      assert.ok(strip.includes(want), `missing ${want}`)
    }
    // Colour is data, and it is now one of five tokens rather than a palette
    // step picked per line: a block means the same thing on every card.
    assert.ok(/bg-signal-[1-5]/.test(strip), "the blocks are the signal scale")
  } finally {
    globalThis.fetch = asked
  }
  console.log("a card with a history draws three strips of twenty blocks")

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

  // The overview row: five tiles, one question each, and the bill to schedule in
  // the last one.
  const { Overview } = await server.ssrLoadModule("/src/components/Overview.tsx")
  const overview = renderToString(createElement(Overview, { nodes: fleet }))
  for (const want of ["节点", "最忙节点", "实时速率", "今日流量", "剩余价值", "0 点起"]) {
    assert.ok(overview.includes(want), `missing ${want}`)
  }
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
  // Two flow tiles, four rows: the arrow and its two letters, then the figure.
  assert.equal(overview.match(/>RX</g)?.length, 2, "one RX row per flow tile")
  assert.equal(overview.match(/>TX</g)?.length, 2, "and one TX")
  // Every unit in those rows is set a step down from its figure, which is what
  // keeps "39.6 MB/s" from reading as one word.
  assert.match(overview, /text-2xs font-normal text-muted-foreground">MB\/s</)
  // The estimate is drawn in dollars whatever the machines are billed in, and
  // the mark is the symbol, not the locale's `US$`.
  assert.match(overview, /text-muted-foreground">\$<\/span>/)
  assert.ok(!overview.includes("US$"))
  // One height for every tile, whatever it holds: the box is what gives the
  // figure its air, and a traffic card with no note must not be shorter.
  assert.equal(overview.match(/min-h-27/g)?.length, 5)
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
  assert.ok(controls.includes("8 台"), "nothing is hidden, so the count is the fleet")
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
  console.log("a group narrows the list, a search narrows the group, the order arranges what is left")

  // The compact card: the same node in a quarter of the height. It keeps the four
  // readings the standard card has -- so a scan does not depend on the sort -- and
  // drops the two wells.
  const compactCards = cards(list({ density: "compact" }))
  assert.ok(compactCards.includes("items-stretch gap-2"), "compact cards sit closer together")
  assert.ok(compactCards.includes("香港-CN2-02"), "a compact card still names the node")
  assert.ok(compactCards.includes("59.90"), "and still shows what it costs")
  for (const want of ["CPU", "内存", "硬盘", "负载"]) {
    assert.ok(compactCards.includes(`>${want}<`), `a compact card keeps ${want}`)
  }
  // Out of a compact card: the cycle-traffic well, the sockets and the strips.
  for (const dropped of ["周期流量", "连接", "grid-cols-20"]) {
    assert.ok(!compactCards.includes(dropped), `a compact card leaves out ${dropped}`)
  }
  console.log("the compact card keeps four readings and drops the wells")

  // The detail page's shell: who the machine is, what it is, and which views it
  // offers. Its charts need effects and a viewport, so what is asserted here is
  // everything above them -- and the one field that must not be here at all.
  const { NodeDetail, Connections } = await server.ssrLoadModule("/src/components/NodeDetail.tsx")
  const { windows } = await server.ssrLoadModule("/src/lib/format.ts")
  const detail = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(NodeDetail, {
      node: fleet[1], historyDays: 7, onBack() {}, ...props,
    }))

  const page = detail()
  // A figure and its unit stay together on a phone: the cell broke "↑ 4.53 GB"
  // after the number and left the unit alone on the next line.
  assert.match(page, /\d\u00a0(?:B|KB|MB|GB|TB)/, "the unit is glued to its figure")
  for (const want of ["香港-CN2-02", "全部节点", "系统", "CPU", "内存 / 硬盘", "架构", "今日流量", "续费"]) {
    assert.ok(page.includes(want), `missing ${want}`)
  }
  // React separates a text child from an expression with a comment.
  assert.match(page, /agent <!-- -->1\.4\.2/)
  // The heading says the state in one word and puts the number in the capsule
  // the list uses: `在线 92d 0h` was a sentence where a state belongs.
  assert.ok(page.includes(">在线<"), "the state is one word")
  assert.ok(!page.includes(">在线 9"), "and the uptime is not glued to it")
  assert.match(page, /<\/svg>\d+d \d+h<\/span>/, "the capsule follows it")
  // Six cells of the spec sheet, so the hairline grid divides into rows of two,
  // three and six.
  assert.equal(page.match(/bg-card-2 px-3 py-2\.5/g)?.length, 6)
  // Six figures above it, which is the question the page is opened with. The
  // spec sheet has its own card and a heading now, a step down from these.
  for (const label of ["CPU", "内存", "硬盘", "负载", "连接", "今日流量"]) {
    assert.ok(page.includes(`text-2xs text-muted-foreground">${label}</span>`), `missing the ${label} figure`)
  }
  assert.equal(page.match(/rounded-lg border border-border-soft bg-card-2 px-3 py-2"/g)?.length, 6, "six tiles")
  assert.ok(page.includes(">规格<"), "the spec sheet is a card with a heading")
  // Figure and unit are set apart on the tiles too: `18` at full weight, `%` a
  // step down, which is the rule the cards and footnotes already follow.
  assert.match(
    page,
    /font-semibold text-foreground text-lg leading-none">\d+(?:\.\d+)?<\/span><span class="ml-1 text-2xs[^"]*">%/,
    "a percentage's sign sits a step down",
  )
  // Two views, one of them on, and every window the hub keeps history for. The
  // 削峰 chip sits on both tabs now -- CPU is clipped by the same switch -- and
  // is off at six hours.
  assert.ok(page.includes('aria-label="视图"'))
  assert.equal(page.match(/aria-pressed="true"/g)?.length, 1 + 1, "one view and one range")
  assert.equal(page.match(/aria-pressed="false"/g)?.length, 1 + (windows(7).length - 1) + 1, "plus 削峰")
  // A public page never shows where the machine is: an operator's `ip` and
  // `hostname` are the panel's.
  const hidden = detail({ node: { ...fleet[1], ip: "203.0.113.7", hostname: "hk-02" } })
  assert.ok(!hidden.includes("203.0.113.7"), "the address stays in the panel")
  assert.ok(!hidden.includes("hk-02"), "and so does the hostname")
  // The note written for visitors. The hub has sent `public_remark` on every
  // frame since the monorepo merge and this page drew the panel-only `remark`
  // instead: a visitor saw no note at all, and a signed-in one saw a note that
  // was never meant for them.
  assert.ok(page.includes("上海移动方向近期丢包偏高"), "the public note reaches the visitor")
  const panelNote = detail({ node: { ...fleet[1], public_remark: "", remark: "恢复密码在 1Password" } })
  assert.ok(panelNote.includes("恢复密码在 1Password"), "a hub without one falls back to the panel's")
  // No renewal date is words on the page rather than `∞`, which is a meter's
  // mark for "no ceiling".
  const undated = detail({ node: { ...fleet[1], expires_at: null, expires_in: null } })
  assert.ok(undated.includes("不限期"), "an undated machine says so in words")
  // The flag is the node's identity here, as on the card.
  assert.match(page, /alt="HK"/)
  console.log("the detail page names the machine, hides its address and offers both views")

  // The connection panel on its own, fed the hub's own answer: the legend is the
  // readout, so each chip carries the count the machine is at now -- the live
  // sample where the hub pushed one, the newest bucket otherwise.
  const sample = fleet[1]!.metrics
  const metricsRows = history(2, "metrics", 6, 60, 1_790_000_000_000).metrics as
    { ts: number; tcp: number; udp: number; procs: number }[]
  const conns = renderToString(createElement(Connections, {
    rows: metricsRows.map((r) => ({ ...r, ts: r.ts * 1_000 })),
    hours: 6,
    live: sample,
  }))
  for (const want of ["连接数", "TCP", "UDP", "进程"]) {
    assert.ok(conns.includes(want), `missing ${want}`)
  }
  for (const [label, value] of [["TCP", sample!.tcp], ["UDP", sample!.udp], ["进程", sample!.procs]] as const) {
    assert.ok(conns.includes(`>${value}</span>`), `${label} shows its live count`)
  }
  assert.equal(conns.match(/aria-pressed="true"/g)?.length, 3, "three series, all drawn")
  console.log("the connection panel counts sockets and processes, and names them")

  // The resource grid: five panels, one of them spanning both columns, each
  // heading carrying the figure the node is at right now -- the node prop
  // updates every two seconds, the history behind the line does not.
  const { Resources } = await server.ssrLoadModule("/src/components/NodeDetail.tsx")
  const resources = renderToString(createElement(Resources, {
    node: fleet[1], points: history(2, "metrics", 6, 60, 1_790_000_000_000).metrics, hours: 6, budget: 600, live: sample,
  }))
  for (const want of ["CPU · 4 核", "内存 ·", "硬盘 ·", "连接数", "网络速率"]) {
    assert.ok(resources.includes(want), `missing ${want}`)
  }
  assert.equal(resources.match(/data-slot="card"/g)?.length, 5, "four resources and the sockets")
  assert.equal(resources.match(/lg:col-span-2/g)?.length, 1, "the network takes the whole row")
  // The heading figure is the live one, not the window's mean. `percentText`
  // keeps a decimal below ten and drops it above, so the same rule is applied
  // here rather than reading a round number off the sample. It is a `Figure`:
  // the figure at full weight, and whatever follows the last space a step down
  // -- so `7.0 MB/s` splits and `38%` does not, which is the same rule the
  // cards follow.
  const cpu = sample!.cpu
  const cpuFigure = cpu < 10 ? cpu.toFixed(1) : cpu.toFixed(0)
  assert.match(resources, new RegExp(`font-semibold text-foreground text-sm">${cpuFigure}%<`), "CPU reads its live figure")
  // React separates the label from the expression that follows it with a comment.
  assert.ok(resources.includes(`负载 <!-- -->${sample!.load[0].toFixed(2)}`), "load beside it")
  assert.match(
    resources,
    /font-semibold text-foreground text-xs">[\d.]+<\/span><span class="ml-1 text-2xs[^"]*">[KMGT]?B\/s</,
    "a rate splits into figure and unit",
  )
  // One hue per figure, on a tint of itself: the square is a label, not data.
  assert.equal(resources.match(/grid shrink-0 place-items-center rounded-md/g)?.length, 5, "five titled squares")
  // The chart chrome the five panels share, asserted where it is defined: an
  // SSR render has no measured width, so recharts emits no surface to look at.
  const { GRID, CURSOR } = await server.ssrLoadModule("/src/components/ChartPanel.tsx")
  assert.equal(GRID.strokeDasharray, "2 4", "the grid is a hairline, not a second series")
  assert.equal(CURSOR.strokeDasharray, "3 3", "and the crosshair is dashed too")
  console.log("the resource grid heads each chart with its live figure")
} finally {
  await server.close()
}
