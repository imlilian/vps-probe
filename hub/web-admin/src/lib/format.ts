const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

const unitOf = (n: number) => Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)

/**
 * 1024-based, as VPS dashboards and `df` report bytes, but labelled MB/GB the way
 * `df -h` and hosting plans write them. Three significant digits by default. Kept
 * in step with the public page's copy of this file.
 */
export function bytes(n: number, digits?: number): string {
  // `< 1` rather than `< 0`: a fraction of a byte puts `unitOf` at -1 and prints
  // "512 undefined".
  if (!n || n < 1) return "0 B"
  const i = unitOf(n)
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : (digits ?? (v >= 100 ? 0 : v >= 10 ? 1 : 2)))} ${UNITS[i]}`
}

export function uptime(seconds: number): string {
  if (!seconds) return "—"
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`
}

/**
 * No expiry and no traffic cap are both rendered as the absence of a ceiling.
 * U+221E rather than the emoji, which arrives as a coloured tile from whatever
 * font the browser provides; this inherits the text colour and size.
 */
export const FOREVER = "∞"

const MONEY = new Map<string, Intl.NumberFormat>()

/**
 * The two currencies this panel is read in, whose mark is the symbol alone.
 *
 * Kept in step with the public page, which draws the same rows with the same
 * marks: the dollar and the yuan are the two a Chinese-language page is written
 * in, and every other currency keeps its region prefix, which is what tells
 * `HK$` and `JP¥` apart from them.
 */
const BARE_MARK = new Set(["USD", "CNY"])

/** A region prefix in front of a symbol: `US$`, `HK$`, `JP¥`, `R$`. */
const PREFIXED_MARK = /^[A-Z]{2,3}([$¥€£₩₹])$/

/**
 * A price as one string: $12.00, ¥12.00, HK$12.00, JP¥1,200, and the code ahead
 * of the amount where the locale has no symbol, as in SGD 12.00. Assembled from
 * [moneyParts], so the string is exactly the mark and the figure the table draws
 * apart.
 */
export function money(amount: number, currency: string): string {
  const { symbol, value } = moneyParts(amount, currency)
  return `${symbol}${value}`.trim()
}

/**
 * The same price in two pieces, for a figure that sets its mark as a unit.
 *
 * Kept in step with the public page's copy of this function, prefix rule
 * included: a price in the table and the same price on the page must read the
 * same way. `symbol` is empty for a code Intl refuses, which leaves the letters
 * of the code on the figure.
 */
export function moneyParts(amount: number, currency: string): { symbol: string; value: string } {
  const format = moneyFormat(currency)
  if (!format) return { symbol: "", value: `${currency} ${amount.toFixed(2)}`.trim() }
  let symbol = ""
  let value = ""
  for (const part of format.formatToParts(amount)) {
    if (part.type === "currency") symbol += part.value
    else value += part.value
  }
  return { symbol: bare(currency, symbol), value: value.trim() }
}

/** The mark a price is drawn with, prefix rule included. */
export function moneyMark(currency: string): string {
  const { symbol } = moneyParts(0, currency)
  return symbol || currency
}

/** The mark without its region prefix, for the currencies read bare. */
function bare(currency: string, symbol: string): string {
  if (!BARE_MARK.has(currency.toUpperCase())) return symbol
  return PREFIXED_MARK.exec(symbol)?.[1] ?? symbol
}

/** One formatter per currency: it costs about 100 µs to build. */
function moneyFormat(currency: string): Intl.NumberFormat | null {
  const cached = MONEY.get(currency)
  if (cached) return cached
  try {
    const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 })
    MONEY.set(currency, format)
    return format
  } catch {
    // Intl throws on anything but three letters, which hubs before 1.3.1 stored
    // unchecked when written through the API.
    return null
  }
}

// The hub stores these lengths under a name and any other as `<n>m`.
const NAMED_CYCLES: Record<string, number> = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12, biennial: 24, triennial: 36 }

/** A billing cycle in months: 0 for one-off, NaN when unrecognized. */
export function cycleMonths(cycle: string): number {
  return cycle === "once" ? 0 : NAMED_CYCLES[cycle] ?? Number(/^(\d+)m$/.exec(cycle)?.[1])
}
