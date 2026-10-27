/// <reference types="node" />
import assert from "node:assert/strict"

import { toUSD } from "./rates.ts"

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
