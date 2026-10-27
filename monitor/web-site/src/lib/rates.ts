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
 * `amount` of `currency` in dollars, or null where the currency is outside the
 * table. A code that cannot be placed is left out of the total and counted
 * instead: the hub holds three letters in whatever spelling the operator typed,
 * and converting one at a guessed rate would put a wrong number in a figure
 * that already asks to be trusted. Letters are matched case-insensitively for
 * the same reason -- the hub uppercases on write, but a database older than that
 * check may not have.
 */
export function toUSD(amount: number, currency: string): number | null {
  const rate = USD_PER[currency.toUpperCase()]
  return rate === undefined ? null : amount * rate
}
