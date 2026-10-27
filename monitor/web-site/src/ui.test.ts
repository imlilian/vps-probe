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
} finally {
  await server.close()
}
