/**
 * The currencies the billing field offers.
 *
 * Asked of the browser rather than written out here: `Intl.supportedValuesOf`
 * is the ISO 4217 set the same engine can name and format, so every code this
 * list offers is one the public page can draw, and nothing has to be kept in
 * step with a table that ages. A code outside it can still be typed into the
 * field -- the hub checks the shape, and a hub older than that check may hold
 * anything.
 *
 * The order is the design: the currencies a self-hosted fleet is actually
 * billed in come first, then everything else alphabetically. The list is the
 * first screen, not the catalogue; a menu long enough that finding `GBP` means
 * scrolling is worse than the bare field it replaced.
 */

const NAMES = new Intl.DisplayNames(["zh-CN"], { type: "currency" })

/** What a self-hosted fleet is billed in, in the order a reader looks for it. */
export const COMMON = [
  "CNY", "USD", "HKD", "TWD", "JPY", "EUR", "GBP", "KRW", "SGD",
  "THB", "MYR", "PHP", "VND", "IDR", "AED", "AUD", "CAD", "CHF", "INR", "RUB", "NZD",
]

export type Currency = { code: string; name: string; mark: string }

/** The Chinese name and the mark of a code, either of which may be the code. */
export function currencyLabel(code: string): { name: string; mark: string } {
  let name = code
  try {
    // `undefined` for a name the locale has no entry for, which leaves the code.
    name = NAMES.of(code) ?? code
  } catch {
    // DisplayNames throws on anything but three letters, which the hub refuses
    // with its own message.
  }
  let mark = code
  try {
    mark =
      new Intl.NumberFormat("zh-CN", { style: "currency", currency: code })
        .formatToParts(0)
        .filter((part) => part.type === "currency")
        .map((part) => part.value)
        .join("") || code
  } catch {
    // Same shape rule: an unformattable code stands as itself.
  }
  return { name, mark }
}

/** Every code this browser can offer, common ones first. */
export function currencyList(): Currency[] {
  const engine = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  let codes: string[] = []
  try {
    codes = engine.supportedValuesOf?.("currency") ?? []
  } catch {
    codes = []
  }
  // A browser without the list still gets the common ones; the field takes any
  // three letters either way.
  if (!codes.length) codes = COMMON
  const known = codes.map((code) => ({ code, ...currencyLabel(code) }))
  const first = COMMON.flatMap((code) => known.filter((c) => c.code === code))
  return [...first, ...known.filter((c) => !COMMON.includes(c.code))]
}

/** The list narrowed by what has been typed: by code, by Chinese name, or by mark. */
export function searchCurrencies(list: Currency[], query: string): Currency[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return list
  return list.filter(
    (c) => c.code.toLowerCase().includes(needle) || c.name.includes(needle) || c.mark.includes(needle),
  )
}

/**
 * The line under the field: the name of what was typed, which is the only check
 * the panel can make of a code the hub stores by shape.
 *
 * It says nothing about whether the public page can convert this currency. That
 * answer is the union of the hub's fetched table and the one the page was built
 * with, which the panel does not have; getting it half right would be worse than
 * leaving it to the page, whose remaining-value card already names how many
 * machines it counted and how many it could not.
 */
export function currencyHint(code: string): string {
  const { name } = currencyLabel(code)
  return name === code ? "未知代码，照原样显示" : name
}
