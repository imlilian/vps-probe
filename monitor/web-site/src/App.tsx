import { lazy, Suspense, useCallback, useEffect, useState } from "react"

import { NodeCard } from "@/components/NodeCard"
import { NodeRow } from "@/components/NodeRow"
import { Overview } from "@/components/Overview"
import { Toolbar } from "@/components/Toolbar"
import { TopBar } from "@/components/TopBar"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, groupsOf, useNodes, type Node } from "@/lib/api"
import { loadConfig } from "@/lib/config"
import { readDensity, readOrder, writeDensity, writeOrder } from "@/lib/prefs"
import { arrange, type Density, type Order } from "@/lib/sort"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

// `history_days` is absent from hubs predating the hourly tier, which kept a
// week for anonymous callers.
type Me = { authed: boolean; github: boolean; site_name: string; public_page: boolean; history_days?: number }

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
  const { mode, cycle: cycleTheme } = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()
  // The list's group tab, held here so it survives a visit to a node's page.
  const [group, setGroup] = useState<string | null>(null)
  // The order and the density are the visitor's, kept across visits: read from
  // `localStorage` on the first render, written when they change. Not in the URL
  // -- nobody shares a link to "my nodes by CPU" -- and not in `theme.json`,
  // which is the site operator's file rather than the reader's.
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
    // Requested alongside /me, not after it. It never rejects: any failure
    // yields the defaults.
    void loadConfig().then(setConfig)
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
    <div className="min-h-svh">
      <TopBar
        siteName={me.site_name || "Monitor"}
        authed={me.authed}
        online={nodes?.filter((n) => n.online).length ?? 0}
        total={nodes?.length ?? 0}
        error={error}
        closed={closed}
        mode={mode}
        onCycleTheme={cycleTheme}
        onHome={() => go(null)}
      />

      <main className="mx-auto max-w-page space-y-5 px-4 py-5 pb-16 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail node={selected} historyDays={me.history_days ?? 7} onBack={() => go(null)} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              节点不存在或未公开。<button className="underline" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes || !config ? (
          <div className={cn("grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", density === "compact" ? "gap-2" : "gap-3")}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className={density === "compact" ? "h-12" : "h-72"} />
            ))}
          </div>
        ) : (
          <NodeList
            nodes={sorted}
            group={group}
            summary={config.show_summary === true}
            order={order}
            density={density}
            onGroup={setGroup}
            onOrder={chooseOrder}
            onDensity={chooseDensity}
            onOpen={go}
          />
        )}
      </main>
    </div>
  )
}

// Group tabs appear only once the operator has grouped something, so a hub
// without groups keeps the page it always had. The summary follows the tab.
//
// Exported for `ui.test.ts`: the combination that has to be right -- a group, an
// order and a density at once -- is this function's, and asserting it through a
// string of markup is the closest this machine gets to opening a browser.
export function NodeList({ nodes, group, summary, order, density, onGroup, onOrder, onDensity, onOpen }: {
  nodes: Node[]
  /** null is every node, "" the ungrouped. */
  group: string | null
  /** The operator's `show_summary` setting. */
  summary: boolean
  order: Order
  density: Density
  onGroup: (group: string | null) => void
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
  // changing the tab keeps the order and changing the order keeps the tab.
  const shown = arrange(current === null ? nodes : nodes.filter((n) => (n.group ?? "") === current), order)
  const compact = density === "compact"
  return (
    <>
      <Toolbar
        nodes={nodes}
        shown={shown.length}
        group={current}
        onGroup={onGroup}
        order={order}
        onOrder={onOrder}
        density={density}
        onDensity={onDensity}
      />
      {summary && <Overview nodes={shown} />}
      {nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有节点</p>
      ) : (
        // Rows stretch so a column of them keeps one line height, offline or not;
        // cards start at the top, since their content is already ragged.
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
