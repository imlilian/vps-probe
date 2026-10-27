import { User } from "lucide-react"

import { browserOf, systemOf } from "@/lib/ua"

/**
 * Who is reading, and from what.
 *
 * The five facts a visitor can check about themselves: whether they are signed
 * in, their system, their browser, their address, and the date. Three of them
 * come from the browser, one from the hub's `/api/me`, and the last from the
 * clock -- no third party, no lookup, nothing stored.
 *
 * The address is the one field that may not arrive: a hub from before the field
 * existed answers without it, so the whole item is dropped rather than shown
 * empty. Nobody needs to be told their IP is on its way -- a footer that says
 * "loading" is worse than a footer with four items.
 *
 * `ua` and `today` are props so the render can be tested without a browser and
 * without depending on the day the test runs.
 */
export function VisitorFooter({ authed, ip, ua, today }: {
  authed: boolean
  /** The caller's address, from `/api/me`. Absent from older hubs. */
  ip?: string
  /** Defaults to the browser's own string. */
  ua?: string
  /** Defaults to now. */
  today?: Date
}) {
  const agent = ua ?? (typeof navigator === "undefined" ? "" : navigator.userAgent)
  const date = today ?? new Date()
  const day = date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })
  return (
    <footer className="mt-auto border-t border-border-soft">
      <div className="mx-auto flex max-w-page flex-col gap-2 px-4 py-5 text-2xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          {/* A gradient disc rather than an avatar: there is nobody to draw, and
              an empty circle reads as a broken image. */}
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-linear-to-br from-violet-400 via-blue-400 to-cyan-400 text-white shadow-card">
            <User size={15} strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">{authed ? "管理员" : "访客"}</div>
            <div>{authed ? "已登录" : "感谢访问"}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:justify-end">
          <span>{systemOf(agent)}</span>
          <Sep />
          <span>{browserOf(agent)}</span>
          {ip && (
            <>
              <Sep />
              {/* An IPv6 address is long enough to push the row apart on a phone:
                  `truncate` keeps it to one line, and `title` has the rest. */}
              <span className="max-w-56 truncate font-mono" title={ip}>{ip}</span>
            </>
          )}
          <Sep />
          <time dateTime={date.toISOString().slice(0, 10)}>{day}</time>
        </div>
      </div>
    </footer>
  )
}

const Sep = () => <span aria-hidden className="text-border">·</span>
