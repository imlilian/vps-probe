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
      siteName: "测试站点", authed: false, online: 7, total: 9, error: null, closed: false,
      mode: "system", onCycleTheme() {}, onHome() {}, ...props,
    }))

  const live = bar({})
  for (const want of ["测试站点", "MONITOR", "7/9", "在线", "主题：跟随系统", "/admin/", "登录"]) {
    assert.ok(live.includes(want), `missing ${want}`)
  }
  console.log("bar names the site, counts the fleet and links the panel")

  // A pending count reads as a dash rather than 0/0 over a page still loading.
  assert.ok(bar({ total: 0, online: 0 }).includes("—"))
  console.log("an unarrived fleet is not counted as zero")

  // The icon is the state: one glyph per mode, so the toggle never lies.
  assert.ok(bar({ mode: "light" }).includes("lucide-sun"))
  assert.ok(bar({ mode: "dark" }).includes("lucide-moon"))
  assert.ok(bar({ mode: "system" }).includes("lucide-monitor"))
  console.log("the theme button shows its mode")

  // A broken stream says so on the pill, which is the only thing in the bar a
  // visitor can look at before the figures below.
  const stale = bar({ error: "实时数据中断，正在重新连接" })
  assert.ok(stale.includes("bg-warn"), "a stale stream should amber the dot")
  assert.ok(stale.includes("实时数据中断"), "the reason belongs in the tooltip")
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
  for (const want of ["香港-CN2-02", "负载", "本月流量", "TCP", "进程", "¥59.9"]) {
    assert.ok(full.includes(want), `missing ${want}`)
  }
  // The figure leads and the unit trails: `412` then a smaller `TCP`. A row of
  // `TCP 412` makes the eye step over the word to reach the number.
  const sockets = fleet[1]!.metrics!
  for (const [value, label] of [[sockets.tcp, "TCP"], [sockets.udp, "UDP"], [sockets.procs, "进程"]] as const) {
    assert.match(full, new RegExp(`>${value}</span><span class="text-2xs[^"]*">${label}<`), `${label} follows its figure`)
  }
  // The latency panel mounts its own container, so its presence is what says a
  // card with a line behind it will draw one.
  assert.ok(full.includes("@container"))
  // Throughput follows the same rule, so the row above the counts is not a
  // different kind of thing: the figure at full weight, the unit a step down.
  assert.match(full, /text-sm font-medium">[\d.]+<\/span><span class="text-2xs[^"]*">(?:B|KB|MB|GB)\/s</)
  // A card is a div carrying role="button", so the focus ring the browser would
  // draw for a real button is ours to draw: without it, tabbing through the list
  // moves nothing on screen.
  assert.match(full, /class="[^"]*focus-visible:ring-\[3px\][^"]*"[^>]*role="button"/)
  console.log("a card carries its figures, its sockets and its price")

  // An offline node has no live line, and the hour it last reported would read
  // as current if the strip were drawn from it.
  assert.ok(!card(7).includes("@container"))
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
    const blocks = strip.match(/h-2\.5 rounded-xs/g)?.length ?? 0
    assert.equal(blocks, 60, `three probes of twenty blocks, got ${blocks}`)
    for (const want of ["上海电信", "上海联通", "上海移动", "ms"]) {
      assert.ok(strip.includes(want), `missing ${want}`)
    }
    // Colour is data: something in the fleet's worst line is not the healthiest
    // step, and the block classes are the palette's, not literals.
    assert.ok(/bg-(emerald|amber|orange|red|muted)/.test(strip))
  } finally {
    globalThis.fetch = asked
  }
  console.log("a card with a history draws three strips of twenty blocks")

  // A node with no probe configured answers with an empty `probes`, and the panel
  // kept its rule and its 24px of padding under nothing: a divider across the
  // bottom of every card, on a fresh install, with no way to see it in the demo
  // (all eight sample nodes carry probes).
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ping: [], probes: {} }), { headers: { "content-type": "application/json" } })
  try {
    fetchPing(3)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(!card(2).includes("@container"), "no probes leaves no frame")
    assert.ok(card(2).includes("本月流量"), "and the rest of the card is untouched")
    // The compact row is the other half of the same answer, and it went the
    // other way: `mergedSignals([])` is an empty array, and the placeholder
    // behind it only fills in for `null`, so the row drew no band at all and
    // broke the column of rows exactly where nothing was configured.
    const { CompactStrip } = await server.ssrLoadModule("/src/components/PingPanel.tsx")
    const row = renderToString(createElement(CompactStrip, { node: fleet[2] }))
    assert.equal(row.match(/h-1 rounded-xs/g)?.length, 20, "the row keeps its twenty blocks")
  } finally {
    globalThis.fetch = asked
    // Put node 3's real history back: the empty answer above was for one card,
    // and the list below counts every online row's band.
    fetchPing(3)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  console.log("a node without probes keeps no empty frame at the bottom")

  // The overview row: four tiles, and the bill to schedule in the last one.
  const { Overview } = await server.ssrLoadModule("/src/components/Overview.tsx")
  const overview = renderToString(createElement(Overview, { nodes: fleet }))
  for (const want of ["节点", "最忙节点", "流量", "剩余价值", "今日", "实时"]) {
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
  assert.match(overview, /text-2xl font-semibold leading-8 tracking-tight">\d+%/, "the peak has no decimal")
  // An expired machine is not one "due within 30 days" -- it is already dark --
  // and adding the two counts makes a third fact that is false.
  const overdue = fleet.map((n, i) => (i === 1 ? { ...n, expires_in: -3, expires_at: "2026-10-20T00:00:00Z" } : n))
  const withExpired = renderToString(createElement(Overview, { nodes: overdue }))
  assert.ok(withExpired.includes("1 台已过期"), "the expired node is counted on its own")
  assert.ok(!withExpired.includes("2 台 30 天内到期"), "and not folded into the 30-day count")
  // Traffic is a table now: the arrows head the rows and the two time scopes
  // are named once, in the title, in the order the columns are drawn.
  assert.match(overview, /流量<span[^>]*>（实时\/今日）</, "the scopes are named in the title")
  assert.ok(overview.indexOf("实时") < overview.indexOf("今日"), "实时 heads the first column")
  // Every unit in that table is set a step down from its figure, which is what
  // keeps "39.6 MB/s" from reading as one word.
  assert.match(overview, /text-2xs[^"]*">MB\/s</)
  assert.match(overview, /text-2xs[^"]*">GB</)
  // The estimate is drawn in dollars whatever the machines are billed in, and
  // the mark is a unit: a size down, and separated from the figure by a gap.
  assert.match(overview, /text-base[^"]*">US\$</)
  // One height for every tile, whatever it holds: the box is what gives the
  // figure its air, and a traffic card with no note must not be shorter.
  assert.equal(overview.match(/min-h-27/g)?.length, 4)
  assert.ok(!overview.includes("0 点累计"), "the traffic tile needs no footnote")
  console.log("the overview counts the fleet, the peak, the traffic and the bill")

  // The toolbar: one control per question, each of them a real control. Ten keys
  // plus 默认, both densities drawn, and the pressed state on exactly one of each
  // -- the chips' and the density pair's -- so nothing is a `<div onClick>`.
  const { Toolbar } = await server.ssrLoadModule("/src/components/Toolbar.tsx")
  const { SORTS } = await server.ssrLoadModule("/src/lib/sort.ts")
  const toolbar = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(Toolbar, {
      nodes: fleet, shown: fleet.length, group: null, onGroup() {},
      order: { key: "operator", dir: "asc" }, onOrder() {}, density: "standard", onDensity() {}, ...props,
    }))

  const controls = toolbar()
  assert.equal(controls.match(/<option/g)?.length, SORTS.length)
  assert.match(controls, /<select[^>]*aria-label="排序"/, "the order is a native select")
  assert.match(controls, /aria-label="[^"]*升序；按下改为降序"/, "the arrow says which way it points")
  assert.equal(controls.match(/aria-pressed="true"/g)?.length, 2, "one chip and one density, pressed")
  // The sample fleet has six groups, so the tabs are drawn; 全部 counts all eight.
  for (const want of ["全部", "香港", "日本", "美国", "新加坡", "欧洲", "国内", "未分组", "标准", "紧凑"]) {
    assert.ok(controls.includes(want), `missing ${want}`)
  }
  assert.ok(controls.includes("8 / 共 8 台"), "the count says nothing is hidden")
  // Compact pressed: still one of each, and the count follows the filter.
  const compactChips = toolbar({ density: "compact", group: "香港", shown: 2 })
  assert.equal(compactChips.match(/aria-pressed="true"/g)?.length, 2)
  assert.ok(compactChips.includes("2 / 共 8 台"))
  console.log("the toolbar offers groups, ten orders and two densities")

  // Group and order together: the tab narrows the list, the order decides what
  // is left, and neither undoes the other.
  const { NodeList } = await server.ssrLoadModule("/src/App.tsx")
  const list = (props: Record<string, unknown> = {}) =>
    renderToString(createElement(NodeList, {
      nodes: fleet, group: null,
      order: { key: "operator", dir: "asc" }, density: "standard",
      onGroup() {}, onOrder() {}, onDensity() {}, onOpen() {}, ...props,
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
  // The summary is part of the page, not a setting: the theme's config API went
  // with the theme market, and this read its default forever anyway.
  assert.ok(whole.includes("最忙节点"), "the four tiles are always drawn")
  console.log("a group narrows the list and the order arranges what is left")

  // The compact list: the same nodes, a tenth of the card. It keeps what a scan
  // asks -- name, state, CPU, memory, the line's hour -- and drops the rest.
  const compactRows = list({ density: "compact" })
  assert.ok(compactRows.includes("items-stretch gap-2"), "rows sit closer together")
  assert.ok(compactRows.includes("香港-CN2-02"), "a row still names the node")
  assert.ok(compactRows.includes("¥59.9"), "and still shows what it costs")
  // Out of a row: the card's traffic block, its socket counts and its older
  // meters. (硬盘 is also a sort option, so it is matched as a meter's label.)
  for (const dropped of ["本月流量", ">TCP<", ">硬盘</span>", ">负载</span>"]) {
    assert.ok(!compactRows.includes(dropped), `a row leaves out ${dropped}`)
  }
  // Twenty blocks of the worst drawn line, filled from the history the strip
  // above already fetched -- the effects behind them never run under SSR. The
  // seven rows that are up reserve the band; only node 2 has a history here, and
  // its band is where the red of its congested probe has to show.
  assert.equal(compactRows.match(/h-1 rounded-xs/g)?.length, 20 * 7, "seven online rows of twenty")
  assert.match(compactRows, /bg-(emerald|amber|orange|red)/, "the band is coloured by the data")
  // Eleven orders above the list, and a row that showed CPU and memory whatever
  // was picked: ordering by 速率 rearranged the page with nothing on it to say
  // why. The figure the order is made of is now on the line -- and only that one,
  // since a row has 48px. Read below the toolbar, which lists every key by name.
  const byRate = cards(list({ density: "compact", order: { key: "rate", dir: "desc" } }))
  assert.match(byRate, />速率</, "a row ordered by rate shows the rate")
  const byExpiry = cards(list({ density: "compact", order: { key: "expiry", dir: "asc" } }))
  assert.match(byExpiry, />到期</, "and one ordered by expiry shows the date")
  const byCpu = cards(list({ density: "compact", order: { key: "cpu", dir: "desc" } }))
  assert.ok(!/>速率</.test(byCpu), "the keys the row already shows add no cell")
  console.log("the compact list keeps the line's hour and drops the rest")

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
  // Six cells of the spec sheet, so the hairline grid divides into rows of two,
  // three and six.
  assert.equal(page.match(/bg-card px-3 py-2\.5/g)?.length, 6)
  // Two views, one of them on, and every window the hub keeps history for.
  assert.ok(page.includes('aria-label="视图"'))
  assert.equal(page.match(/aria-pressed="true"/g)?.length, 1 + 1, "one view and one range")
  assert.equal(page.match(/aria-pressed="false"/g)?.length, 1 + (windows(7).length - 1))
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
    node: fleet[1], points: history(2, "metrics", 6, 60, 1_790_000_000_000).metrics, hours: 6, live: sample,
  }))
  for (const want of ["CPU · 4 核", "内存 ·", "硬盘 ·", "连接数", "网络速率"]) {
    assert.ok(resources.includes(want), `missing ${want}`)
  }
  assert.equal(resources.match(/data-slot="card"/g)?.length, 5, "four resources and the sockets")
  assert.equal(resources.match(/lg:col-span-2/g)?.length, 1, "the network takes the whole row")
  // The heading figure is the live one, not the window's mean. `percentText`
  // keeps a decimal below ten and drops it above, so the same rule is applied
  // here rather than reading a round number off the sample.
  const cpu = sample!.cpu
  assert.ok(resources.includes(`${cpu < 10 ? cpu.toFixed(1) : cpu.toFixed(0)}%`), "CPU reads its live figure")
  assert.ok(resources.includes(`负载 ${sample!.load[0].toFixed(2)}`))
  console.log("the resource grid heads each chart with its live figure")
} finally {
  await server.close()
}
