import { browserOf, systemOf } from "@/lib/ua"

/**
 * Who is reading, and from what.
 *
 * The four facts a visitor can check about themselves: their system, their
 * browser, their address, and the date. Three come from the browser, one from
 * the hub's `/api/me`, and the last from the clock -- no third party, no lookup,
 * nothing stored.
 *
 * Centred, and only these four. A gradient disc and a `访客 / 感谢访问` block used
 * to sit on the left with the facts pushed to the right edge; the block said
 * nothing the page had not already said (the header names the site, and the way
 * into the panel is in the same bar), and a two-column footer made the reader
 * scan two unrelated edges for one line of small print. One centred line reads
 * as a colophon, which is what it is.
 *
 * The address is the one field that may not arrive: a hub from before the field
 * existed answers without it, so the whole item is dropped rather than shown
 * empty. Nobody needs to be told their IP is on its way -- a footer that says
 * "loading" is worse than a footer with three items.
 *
 * `ua` and `today` are props so the render can be tested without a browser and
 * without depending on the day the test runs.
 */
export function VisitorFooter({ ip, ua, today }: {
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
    // No hairline across the top. The page's ground is one continuous wash, and
    // a rule drawn over it turned the colophon into a separate white strip: the
    // pixels either side are the same colour, so the line was the entire
    // "seam". Space does the separating instead.
    <footer className="mt-auto">
      {/* Centred and allowed to wrap: on a phone these four facts need two lines,
          and a row that wraps while centred stays one block of text. The
          separators go at that width -- an orphaned `·` at the end of a line is
          punctuation for a list that is no longer on one line -- and the wider
          gap takes over the job of telling the items apart. */}
      <div className="mx-auto flex max-w-page flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-5 text-2xs text-muted-foreground sm:gap-x-2 sm:px-6">
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
    </footer>
  )
}

/** The mark between two facts, on one line only. */
const Sep = () => <span aria-hidden className="hidden text-border sm:inline">·</span>
