/// <reference types="node" />
import assert from "node:assert/strict"

import { RATES_AS_OF, readRates, ratesAsOf, toUSD } from "./rates.ts"

// Every currency the billing form is expected to see resolves; a table missing
// one silently drops those nodes out of the remaining-value total.
for (const code of ["USD", "CNY", "EUR", "GBP", "JPY", "HKD", "TWD", "KRW", "SGD", "CAD", "AUD", "CHF"]) {
  assert.ok(toUSD(1, code), `${code} should have a rate`)
}
assert.equal(toUSD(10, "USD"), 10, "dollars are already dollars")
console.log("every billed currency converts")

// The hub uppercases a code on write, but a row stored before that check ran
// may not be, and the lookup should not care.
assert.equal(toUSD(1, "cny"), toUSD(1, "CNY"))
console.log("a lower-case code finds its rate")

// Asserted as a range rather than a value: refreshing the table must not turn
// this red. A yuan is worth between ten and twenty cents.
const yuan = toUSD(1, "CNY")
assert.ok(yuan !== null && yuan > 0.1 && yuan < 0.2, `a yuan is worth ${yuan}`)
// And a euro more than a dollar, which is what the direction of the conversion
// would look like if the table held units-per-dollar by mistake.
const euro = toUSD(1, "EUR")
assert.ok(euro !== null && euro > 1 && euro < 1.5, `a euro is worth ${euro}`)
console.log("rates run in the direction the conversion needs")

// A code the table cannot place is null rather than a silent pass at par, which
// would price a machine in a currency nobody quoted.
assert.equal(toUSD(1, "XYZ"), null)
assert.equal(toUSD(1, ""), null)
console.log("an unknown code is refused, not guessed")

// The hub's own table, as `/api/rates` answers it. It replaces the baked one, so
// a hub that has fetched drives the estimate; the date printed beside the figure
// is the one that belongs to the table actually used.
{
  const table = readRates({ fetched: "2026-10-29", date: "2026-10-28", usd_per: { USD: 1, GBP: 1.33, xyz: 0 } })
  assert.deepEqual(table, { date: "2026-10-28", usdPer: { USD: 1, GBP: 1.33 } }, "读数：大写代码，非正数丢掉")
  assert.equal(readRates({}), null, "没抓过的 hub 答 {}，留着内嵌表")
  assert.equal(readRates(null), null, "不是对象也不认")
  assert.equal(readRates({ date: "2026-10-28", usd_per: {} }), null, "空表等于没表")
  assert.equal(readRates({ usd_per: { USD: 1 } })?.date, RATES_AS_OF, "没给日期就用内嵌表的日期")
  // 形状不对的一律丢掉：非三位字母的代码、非正数、非有限数，以及日期不是 YYYY-MM-DD
  const odd = readRates({
    date: "2026-10-28T00:00:00Z",
    usd_per: { USD: 1, gbp: 1.3, USDT: 1, "港币": 1, JPY: Infinity, KRW: -1, SEK: null },
  })
  assert.deepEqual(odd, { date: RATES_AS_OF, usdPer: { USD: 1, GBP: 1.3 } }, "形状不对的汇率不进门")
  // Nothing has been published, so the estimate still quotes the baked table's
  // day: a hub that has not fetched must not claim today's rates.
  assert.equal(ratesAsOf(), RATES_AS_OF)
  console.log("the hub's table is read whole, and an empty answer leaves the baked one alone")
}
