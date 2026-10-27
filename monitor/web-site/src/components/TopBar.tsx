import { useEffect, useState } from "react"
import { Monitor, Moon, Sun, Wrench } from "lucide-react"

import { Button } from "@/components/ui/button"
import { MODE_LABEL, type ThemeMode } from "@/lib/theme"
import { cn } from "@/lib/utils"

type Props = {
  siteName: string
  authed: boolean
  online: number
  total: number
  /** What the live stream is doing; `useNodes` reports either flag. */
  error: string | null
  closed: boolean
  mode: ThemeMode
  onCycleTheme: () => void
  /** The name is the way back to the list, so a node page needs no back button. */
  onHome: () => void
}

/**
 * The bar every page sits under: who this is, whether the figures below are
 * current, the time, and the two ways out of the page -- the theme and the
 * panel.
 *
 * The clock is a component of its own because it is the only thing here that
 * changes every second; held in `TopBar` it would re-render the header, and the
 * header's parent, once a second for a figure nobody reads that closely.
 */
export function TopBar({ siteName, authed, online, total, error, closed, mode, onCycleTheme, onHome }: Props) {
  // A closed status page redirects an anonymous visitor; a signed-in one can
  // still be looking at the list, and the pill has to say why it stopped.
  const state = closed ? "closed" : error ? "stale" : "live"
  const detail = closed ? "公开状态页已关闭" : error ?? `共 ${total} 个节点`

  return (
    <header className="sticky top-0 z-20 border-b bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-page items-center gap-2 px-4 sm:gap-3 sm:px-6">
        <button
          className="flex min-w-0 items-center gap-2.5 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={onHome}
          title="返回列表"
        >
          {/* The hub stamps this path with the icon the operator uploaded, or
              with the theme's own if they uploaded none. */}
          <img src="/favicon.svg" alt="" className="size-7 shrink-0 rounded-lg" />
          <span className="truncate text-sm font-semibold tracking-tight">{siteName}</span>
          <span className="hidden shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium tracking-widest text-muted-foreground sm:inline">
            MONITOR
          </span>
        </button>

        <div className="flex-1" />

        <span
          className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs"
          title={detail}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              state === "live" ? "bg-online" : state === "stale" ? "bg-warn" : "bg-offline",
            )}
          />
          {/* Before the first frame arrives there is no total, and "0/0" over a
              page that is still loading reads as "nothing is up". */}
          <span className="tnum font-medium">{total ? `${online}/${total}` : "—"}</span>
          <span className="hidden text-muted-foreground sm:inline">在线</span>
        </span>

        <Clock />

        {/* One button, three states. The icon is the state; the title says it in
            words for anyone who cannot tell a monitor from a moon. */}
        <Button variant="ghost" size="icon" onClick={onCycleTheme} title={`主题：${MODE_LABEL[mode]}`} aria-label={`主题：${MODE_LABEL[mode]}`}>
          {mode === "light" ? <Sun /> : mode === "dark" ? <Moon /> : <Monitor />}
        </Button>

        {/* The panel is a separate app built into the hub, not a route of this
            one, so this is a navigation rather than a link within the theme.
            On a phone the label is dropped and only the wrench is left, which
            would leave the link with no accessible name at all: the words move
            from `hidden` into `aria-label` and `title` rather than away. */}
        <Button variant="ghost" size="sm" asChild>
          <a href="/admin/" aria-label={authed ? "进入后台" : "登录"} title={authed ? "进入后台" : "登录"}>
            <Wrench />
            <span className="hidden sm:inline">{authed ? "进入后台" : "登录"}</span>
          </a>
        </Button>
      </div>
    </header>
  )
}

/**
 * Wall clock, second hand included: on a page whose whole point is "is it live
 * right now", a figure that moves is the cheapest proof that the tab is awake.
 * Re-armed against the wall rather than by a 1000ms interval, which drifts and
 * would skip a second whenever the tab is throttled.
 */
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const next = new Date()
      setNow(next)
      timer = setTimeout(tick, 1000 - next.getMilliseconds())
    }
    timer = setTimeout(tick, 1000 - new Date().getMilliseconds())
    return () => clearTimeout(timer)
  }, [])
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    <span className="tnum hidden text-xs text-muted-foreground sm:block" aria-hidden>
      {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </span>
  )
}
