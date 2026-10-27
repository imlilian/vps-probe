import { useEffect, useState } from "react"
import { ArrowRight, Monitor, Moon, Sun, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Glyph } from "@/components/ui/glyph"
import { MODE_LABEL, type ThemeMode } from "@/lib/theme"
import { cn } from "@/lib/utils"

type Props = {
  siteName: string
  authed: boolean
  /** What the live stream is doing; `useNodes` reports either flag. */
  error: string | null
  closed: boolean
  mode: ThemeMode
  onMode: (mode: ThemeMode) => void
  /** The name is the way back to the list, so a node page needs no back button. */
  onHome: () => void
}

/** The slider's three stops, in the order they are drawn. */
const MODES: { mode: ThemeMode; icon: LucideIcon }[] = [
  { mode: "light", icon: Sun },
  { mode: "dark", icon: Moon },
  { mode: "system", icon: Monitor },
]

/**
 * The bar every page sits under: who this is, whether the figures below are
 * current, and the two ways out of the page -- the theme and the panel.
 *
 * The pill says `实时连接` and the time, and nothing about how many nodes are up.
 * That count had its own badge here until the summary moved below it: a `7/8`
 * in the corner and a `7 / 8` in a card forty pixels away is the same fact
 * twice, and the smaller of the two reads as a status light rather than as a
 * figure. What the header can say that no card can is whether the stream behind
 * every figure on the page is still open -- so that is what it says, in the same
 * place, with the dot as the fast answer and the words as the slow one.
 */
export function TopBar({ siteName, authed, error, closed, mode, onMode, onHome }: Props) {
  // A closed status page redirects an anonymous visitor; a signed-in one can
  // still be looking at the list, and the pill has to say why it stopped.
  const state = closed ? "closed" : error ? "stale" : "live"
  const detail = closed ? "公开状态页已关闭" : error ?? "数据是实时的"

  return (
    <header className="sticky top-0 z-30 border-b bg-background/75 backdrop-blur-xl">
      {/* Wraps below 416px: the name, the pill, three theme stops and the way
          out do not share 328px, and the row that loses is the name -- it was
          truncating to `VP…` so that four controls could fit beside it. Under
          `xs` the controls take a line of their own and the name keeps its
          width; above it everything is one row again. */}
      <div className="mx-auto flex min-h-14 max-w-page flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2 xs:flex-nowrap xs:gap-x-3 xs:py-0 sm:px-6">
        <button
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md outline-none transition-opacity hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onHome}
          title="返回列表"
        >
          {/* The hub stamps this path with the icon the operator uploaded, or
              with the theme's own if they uploaded none. */}
          <img src="/favicon.svg" alt="" className="size-7 shrink-0 rounded-lg shadow-sm ring-1 ring-foreground/10" />
          <span className="truncate text-sm font-bold tracking-tight">{siteName}</span>
          {/* The separator and the badge are the brand's full form: a page whose
              tab is 40px wide still gets the name alone. */}
          <span aria-hidden className="hidden font-light text-border sm:inline">/</span>
          <span className="hidden shrink-0 rounded border bg-card-2 px-1.5 py-0.5 text-2xs font-semibold tracking-widest text-muted-foreground sm:inline">
            MONITOR
          </span>
        </button>

        <div className="flex w-full items-center justify-end gap-2 xs:ml-auto xs:w-auto xs:gap-3">
          <span
            role="status"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-2xs"
            title={detail}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                state === "live" ? "bg-online" : state === "stale" ? "bg-warn" : "bg-offline",
              )}
            />
            <span className="font-medium whitespace-nowrap">
              {state === "live" ? "实时连接" : state === "stale" ? "重新连接" : "已断开"}
            </span>
            {/* The clock is the proof that the words are still true: a figure
                that moves is harder to fake than a dot. It goes on a phone,
                where the pill would otherwise spend the width the site name
                needs. */}
            <span aria-hidden className="hidden text-muted-foreground/50 sm:inline">·</span>
            <Clock />
          </span>

          {/* Three stops on one trough, and the icon is the whole label: a sun, a
              moon and a screen need no translation, and the words that used to be
              here were the widest thing in the bar. One button that cycles was
              the alternative and it is worse than it looks -- a press has to be
              aimed at a state you cannot see from outside it. */}
          <div role="group" aria-label="主题" className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border bg-card-2 p-0.5">
            {MODES.map(({ mode: value, icon }) => (
              <button
                key={value}
                aria-pressed={mode === value}
                aria-label={`主题：${MODE_LABEL[value]}`}
                title={`主题：${MODE_LABEL[value]}`}
                onClick={() => onMode(value)}
                className={cn(
                  "grid size-7 place-items-center rounded-md outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  // The chosen stop is a raised surface, not a lighter label: on
                  // `bg-card` the dark half drew it below the track, where it read
                  // as a hole. The hairline is for the dark side, where a shadow
                  // cannot show.
                  mode === value
                    ? "bg-selected text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Glyph icon={icon} box="sm" />
              </button>
            ))}
          </div>

          {/* The panel is a separate app built into the hub, not a route of this
              one, so this is a navigation rather than a link within the theme.
              Solid ink rather than an outline: it is the one thing in the bar
              that leaves the page, and the card below it is already white. */}
          <Button
            asChild
            className="group h-8 shrink-0 gap-1.5 rounded-lg bg-foreground px-2.5 text-xs font-medium text-background hover:bg-foreground/85 sm:px-3"
          >
            <a href="/admin/" aria-label={authed ? "控制台" : "登录"} title={authed ? "进入后台控制台" : "登录后台"}>
              <span className="whitespace-nowrap">{authed ? "控制台" : "登录"}</span>
              <Glyph icon={ArrowRight} box="sm" className="transition-transform group-hover:translate-x-0.5" />
            </a>
          </Button>
        </div>
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
    <span className="tnum hidden text-muted-foreground sm:inline" aria-hidden>
      {pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}
    </span>
  )
}
