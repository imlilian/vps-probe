import { useEffect } from "react"

import { api } from "./api.ts"

/**
 * The table the remaining-value estimate converts with.
 *
 * A fleet billed in yuan, euros and dollars has no single "what is left" until
 * the three are put on one scale, and the card exists to answer that question
 * rather than to list three numbers. Everything is converted to US dollars,
 * which is what hosts quote in and what a visitor can compare.
 *
 * The rates are the ECB reference rates as frankfurter.dev publishes them, as
 * dollars per unit, read on the date below. They are baked in rather than
 * fetched: the public page is served under `connect-src 'self'`, so a request
 * to a rate API is refused by the browser before it leaves the tab, and
 * widening that policy for a figure that is already an estimate would trade a
 * real guarantee for a decimal place. The nearest reference -- Komari's Horizon
 * theme -- ships the same shape of table and only overrides it if its own fetch
 * succeeds; this is that, with the fetch removed.
 *
 * A table ages. What it feeds is a prorated guess shown to the nearest dollar,
 * and between refreshes it is off by a few percent at most; refreshing means
 * editing the numbers and the date beside them.
 */
export const RATES_AS_OF = "2026-10-27"

/** What one unit of each currency is worth in dollars. */
const USD_PER: Record<string, number> = {
  USD: 1,
  EUR: 1.120913,
  GBP: 1.337095,
  CHF: 1.211989,
  SGD: 0.781677,
  CAD: 0.713827,
  AUD: 0.702149,
  HKD: 0.12739,
  CNY: 0.150042,
  TWD: 0.030715,
  INR: 0.010524,
  RUB: 0.012366,
  JPY: 0.006361,
  KRW: 0.000755,
}

/**
 * `amount` of `currency` in dollars, or null where neither table can place the
 * currency. A code that cannot be placed is left out of the total and counted
 * instead: the hub holds three letters in whatever spelling the operator typed,
 * and converting one at a guessed rate would put a wrong number in a figure that
 * already asks to be trusted. Letters are matched case-insensitively for the
 * same reason -- the hub uppercases on write, but a database older than that
 * check may not have.
 */
export function toUSD(amount: number, currency: string): number | null {
  const code = currency.toUpperCase()
  const rate = hub?.usdPer[code] ?? USD_PER[code]
  return rate === undefined ? null : amount * rate
}

/** The day whose rates an estimate is based on. */
export function ratesAsOf(): string {
  return hub?.date ?? RATES_AS_OF
}

/** The hub's table, as `/api/rates` answers it. */
export type Table = { date: string; usdPer: Record<string, number> }

let hub: Table | null = null
let asked = false
const listeners = new Set<() => void>()

/** Reads the hub's table once per visit, keeping whatever it can use from it. */
export function useHubRates(): void {
  useEffect(() => {
    if (asked) return
    asked = true
    api<Record<string, unknown>>("/rates")
      .then((body) => {
        const table = readRates(body)
        if (!table) return
        hub = table
        for (const listener of listeners) listener()
      })
      // No hub answer means the baked table stands, which is the same trade the
      // public page makes everywhere else: a figure backed by less data rather
      // than no figure.
      .catch(() => {})
  }, [])
}

/**
 * A hub answer as a table, or null where it holds nothing usable.
 *
 * Exported for the test that pins the two answers a hub can give: a real table,
 * which replaces the baked one, and `{}` from a hub that has not fetched yet,
 * which must leave it alone rather than blank every price on the page.
 */
export function readRates(body: unknown): Table | null {
  if (!body || typeof body !== "object") return null
  const fields = body as Record<string, unknown>
  const usdPer = fields.usd_per
  if (!usdPer || typeof usdPer !== "object") return null
  // Held to the shape the hub promises to serve, and to nothing more: three
  // letters per code, a positive finite number for a rate, and a bounded count.
  // The hub checks its source the same way, but this end is what turns an answer
  // into divisions, and an infinity here would print as `∞` on a price.
  const table: Record<string, number> = {}
  for (const [code, value] of Object.entries(usdPer as Record<string, unknown>).slice(0, LIMIT)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && /^[A-Za-z]{3}$/.test(code)) {
      table[code.toUpperCase()] = value
    }
  }
  if (!Object.keys(table).length) return null
  const date = typeof fields.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.date) ? fields.date : RATES_AS_OF
  return { date, usdPer: table }
}

/** How many currencies an answer may carry: the hub's own ceiling, mirrored. */
const LIMIT = 400
