import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"

import { NodeCard } from "@/components/NodeCard"
import { NodeRow } from "@/components/NodeRow"
import { Overview } from "@/components/Overview"
import { Toolbar } from "@/components/Toolbar"
import { TopBar } from "@/components/TopBar"
import { VisitorFooter } from "@/components/VisitorFooter"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupsOf, useNodes, type Node } from "@/lib/api"
import { readDensity, readOrder, writeDensity, writeOrder } from "@/lib/prefs"
import { arrange, type Density, type Order } from "@/lib/sort"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

// `history_days` is absent from hubs predating the hourly tier, which kept a
// week for anonymous callers.
type Me = { authed: boolean; github: boolean; site_name: string; public_page: boolean; history_days?: number; ip?: string }

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 288 kB rather than 678 kB (95 kB gzipped against
// 207 kB), with the rest fetched immediately after it paints.
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
function useNodeRoute() {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => setId(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    id,
    (next: number | null) => {
      const path = next === null ? "/" : `/node/${next}`
      // The site name leads to the list from the list as well, and each repeat
      // would otherwise cost one more press of back.
      if (location.pathname !== path) history.pushState({}, "", path)
      setId(next)
      scrollTo(0, 0)
    },
  ] as const
}

export default function App() {
  const { mode, choose: chooseTheme } = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, at, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  // Which card was pressed on the way to a node page. A card is a `role="button"`
  // that unmounts when its page opens, so the browser drops focus back to `body`
  // and a keyboard reader looking at node 12 comes back to the top of the
  // document rather than to node 12's row.
  const lastOpened = useRef<number | null>(null)
  const openNode = useCallback((id: number) => {
    lastOpened.current = id
    go(id)
  }, [go])
  useEffect(() => {
    if (open !== null || lastOpened.current === null) return
    document.querySelector<HTMLElement>(`[data-node="${lastOpened.current}"]`)?.focus()
    lastOpened.current = null
  }, [open])
  // The list's group tab and its search, held here so they survive a visit to a
  // node's page.
  const [group, setGroup] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // The order and the density are the visitor's, kept across visits: read from
  // `localStorage` on the first render, written when they change. Not in the URL
  // -- nobody shares a link to "my nodes by CPU" -- and not in a settings file
  // either: those would be the site operator's, and these are the reader's.
  const [order, setOrder] = useState<Order>(readOrder)
  const [density, setDensity] = useState<Density>(readDensity)
  const chooseOrder = useCallback((next: Order) => {
    setOrder(next)
    writeOrder(next)
  }, [])
  const chooseDensity = useCallback((next: Density) => {
    setDensity(next)
    writeDensity(next)
  }, [])

  const loadMe = useCallback(() => {
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message))
  }, [])

  useEffect(() => {
    loadMe()
    // Warmed here rather than left to Suspense, which requests the chunk only
    // once a render reaches the detail view, itself waiting on /me. Without this
    // the split trades its first paint for a full-page skeleton over the first
    // node opened: 2.6s click-to-chart on 4G against 1.4s unsplit, 1.7s warm.
    void loadDetail()
  }, [loadMe])

  // The status page was closed while this tab was open. `me` holds whatever it
  // reported at load, so it is re-queried; the effect below then directs an
  // anonymous visitor to the panel rather than leaving them on a list that
  // stopped updating with only a red line to explain it.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  const sorted = [...(nodes ?? [])].sort((a, b) => a.sort - b.sort || a.id - b.id)
  const selected = sorted.find((n) => n.id === open)

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  useEffect(() => {
    document.title = [selected?.name, me?.site_name || "Monitor"].filter(Boolean).join(" · ")
  }, [selected?.name, me?.site_name])

  // Only while there is nothing else to show. Once `me` has loaded, a later
  // failure belongs beside the page rather than over it.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm">
      {meError ? (
        <div className="space-y-3 text-center">
          <p role="alert" className="text-destructive">加载失败：{meError}</p>
          <Button onClick={loadMe}>重试</Button>
        </div>
      ) : (
        <p className="animate-pulse text-muted-foreground">加载中…</p>
      )}
    </div>
  )

  // The status page is closed and nobody is signed in: redirect to the panel.
  if (!me.public_page && !me.authed) return null

  return (
    <div className="flex min-h-svh flex-col">
      <TopBar
        siteName={me.site_name || "Monitor"}
        authed={me.authed}
        error={error}
        closed={closed}
        mode={mode}
        onMode={chooseTheme}
        onHome={() => go(null)}
      />

      {/* No error line above the page: the header's pill is where a broken
          stream is announced, and a red sentence between the bar and the
          summary repeated it in the place a visitor looks for a warning about
          their own machine. */}
      <main className="mx-auto w-full max-w-page flex-1 space-y-4 px-4 py-5 pb-10 sm:px-6">
        {open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail
                node={selected}
                at={at}
                historyDays={me.history_days ?? 7}
                onBack={() => go(null)}
                nodes={sorted}
                onOpen={openNode}
              />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开。<button
                className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={() => go(null)}
              >返回列表</button>
            </p>
          )
        ) : !nodes ? (
          <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className={density === "compact" ? "h-40" : "h-80"} />
            ))}
          </div>
        ) : (
          <NodeList
            nodes={sorted}
            group={group}
            query={query}
            order={order}
            density={density}
            onGroup={setGroup}
            onQuery={setQuery}
            onOrder={chooseOrder}
            onDensity={chooseDensity}
            onOpen={openNode}
          />
        )}
      </main>

      {/* The address is the hub's answer, so it follows `me`: the footer draws
          its own facts on the first frame and gains the address when it arrives,
          rather than holding the whole line back for it. */}
      <VisitorFooter ip={me.ip} />
    </div>
  )
}

// Group tabs appear only once the operator has grouped something, so a hub
// without groups keeps the page it always had. The summary follows the tab, and
// is no longer a switch: it was the operator's `show_summary` from the theme
// config API, which the hub does not have, so it always read its own default.
//
// Exported for `ui.test.ts`: the combination that has to be right -- a group, a
// search, an order and a density at once -- is this function's, and asserting it
// through a string of markup is the closest this machine gets to opening a
// browser.
export function NodeList({ nodes, group, query, order, density, onGroup, onQuery, onOrder, onDensity, onOpen }: {
  nodes: Node[]
  /** null is every node, "" the ungrouped. */
  group: string | null
  query: string
  order: Order
  density: Density
  onGroup: (group: string | null) => void
  onQuery: (query: string) => void
  onOrder: (order: Order) => void
  onDensity: (density: Density) => void
  onOpen: (id: number) => void
}) {
  const groups = groupsOf(nodes)
  const ungrouped = nodes.filter((n) => !n.group).length
  // A tab that has since emptied or been renamed -- 未分组 included -- falls back
  // to every node rather than to an empty page, and is forgotten, so a later
  // group of the same name does not take the page over.
  const current = group === null || (group === "" ? ungrouped > 0 : groups.includes(group)) ? group : null
  useEffect(() => {
    if (current !== group) onGroup(current)
  }, [current, group, onGroup])
  // Filter, then arrange: a group is a set and an order is a view of that set, so
  // changing the tab keeps the order and changing the order keeps the tab. The
  // search is a third set -- it narrows within the tab, and clearing it brings
  // the tab back rather than the whole fleet.
  const inGroup = current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current)
  const needle = query.trim().toLowerCase()
  const matched = needle ? nodes.filter((n) => n.name.toLowerCase().includes(needle)) : nodes
  const searched = needle ? inGroup.filter((n) => n.name.toLowerCase().includes(needle)) : inGroup
  const shown = arrange(searched, order)
  const compact = density === "compact"
  return (
    <>
      {/* The summary first, the controls second: the row of five answers what the
          page is before it offers to change it, and the summary follows the
          filters below it rather than the fleet. */}
      <Overview nodes={shown} />
      <Toolbar
        nodes={nodes}
        found={matched}
        shown={shown.length}
        group={current}
        onGroup={onGroup}
        order={order}
        onOrder={onOrder}
        density={density}
        onDensity={onDensity}
        query={query}
        onQuery={onQuery}
      />
      {nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
      ) : shown.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{needle ? "没有匹配的节点" : "这个分组里没有节点"}</p>
      ) : (
        // Cards of one density keep one height per row: a compact card is a
        // fixed list of four figures and two lines, so stretching it costs
        // nothing and lines the grid up; a standard card's content is already
        // ragged, so those start at the top.
        <div className={cn(
          "grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
          compact ? "items-stretch gap-2" : "items-start gap-3",
        )}>
          {shown.map((n) => compact
            ? <NodeRow key={n.id} node={n} onOpen={() => onOpen(n.id)} />
            : <NodeCard key={n.id} node={n} onOpen={() => onOpen(n.id)} />)}
        </div>
      )}
    </>
  )
}
