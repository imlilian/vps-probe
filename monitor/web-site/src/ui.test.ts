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
  console.log("a card carries its figures, its sockets and its price")

  // An offline node has no live line, and the hour it last reported would read
  // as current if the strip were drawn from it.
  assert.ok(!card(7).includes("@container"))
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

  // The overview row: four tiles, and the bill to schedule in the last one.
  const { Overview } = await server.ssrLoadModule("/src/components/Overview.tsx")
  const overview = renderToString(createElement(Overview, { nodes: fleet }))
  for (const want of ["节点", "最忙节点", "流量", "剩余价值", "今日", "实时"]) {
    assert.ok(overview.includes(want), `missing ${want}`)
  }
  // Seven of the eight sample nodes are up. React separates two text children
  // with a comment, so the pair is matched rather than searched for.
  assert.match(overview, /7<span[^>]*> \/ <!-- -->8/)
  // Two sample nodes are inside the month, so the row has to say a bill is
  // coming rather than that nothing is.
  assert.match(overview, /台 30 天内到期/)
  assert.ok(!overview.includes("无近期到期"))
  // Traffic is a table now: the arrows head the rows, the two time scopes the
  // columns, and the present comes first because it is the one that is moving.
  assert.ok(overview.indexOf("实时") < overview.indexOf("今日"), "实时 heads the first column")
  // Every unit in that table is set a step down from its figure, which is what
  // keeps "39.6 MB/s" from reading as one word.
  assert.match(overview, /text-2xs[^"]*">MB\/s</)
  assert.match(overview, /text-2xs[^"]*">GB</)
  // The currency mark is a unit too, and separated from the figure by a gap.
  assert.match(overview, /text-base[^"]*">¥</)
  console.log("the overview counts the fleet, the peak, the traffic and the bill")
} finally {
  await server.close()
}
