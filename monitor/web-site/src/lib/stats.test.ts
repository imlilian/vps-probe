/// <reference types="node" />
import assert from "node:assert/strict"

import type { Metrics, Node } from "./api.ts"
import { busiest, due, fleet, live, residual, today } from "./stats.ts"

const metrics = (cpu: number, rx = 0, tx = 0): Metrics => ({
  uptime: 100, cpu, load: [0, 0, 0],
  mem_total: 0, mem_used: 0, swap_total: 0, swap_used: 0,
  disk_total: 0, disk_used: 0,
  net_rx: rx, net_tx: tx, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
  tcp: 0, udp: 0, procs: 0,
})

const node = (patch: Partial<Node>): Node => ({
  id: 1, name: "n", sort: 0, public: true, online: true, country: "", last_seen: 0,
  metrics: null, os: "", kernel: "", arch: "", virt: "none", cpu_name: "", cpu_cores: 1,
  mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
  price: 0, currency: "CNY", billing_cycle: "monthly", expires_at: null,
  traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
  ...patch,
})

// Online is the count of nodes that are reporting, not of nodes that never left.
assert.deepEqual(fleet([node({ online: true }), node({ online: true }), node({ online: false })]),
  { total: 3, online: 2, offline: 1 })
assert.deepEqual(fleet([]), { total: 0, online: 0, offline: 0 })
console.log("the fleet counts what is up")

// Busiest is the peak, not the average, and a node that stopped reporting is not
// a candidate however high its last figure was.
assert.equal(busiest([node({ name: "a", metrics: metrics(12) }), node({ name: "b", metrics: metrics(91) }),
  node({ name: "c", online: false, metrics: metrics(99) })])?.node.name, "b")
assert.equal(busiest([node({ online: false, metrics: metrics(99) })]), null)
console.log("the busiest node is the peak of those still reporting")

// Today's counters outlive a disconnect -- the hub keeps them -- so an offline
// node still contributes. Throughput does not: it is a live figure.
const day = [node({ day_rx: 100, day_tx: 10 }), node({ online: false, day_rx: 5, day_tx: 1 })]
assert.deepEqual(today(day), { rx: 105, tx: 11 })
assert.deepEqual(live([node({ metrics: metrics(1, 8, 2) }), node({ online: false, metrics: metrics(1, 99, 99) })]),
  { rx: 8, tx: 2 })
assert.deepEqual(live([]), { rx: 0, tx: 0 })
console.log("today keeps counting while throughput does not")

// 40 a month with 15 days left is 20; a plan already past its date is worth 0
// rather than a negative amount; a one-off purchase has no period to prorate.
const plans = [
  node({ price: 40, billing_cycle: "monthly", expires_in: 15 }),
  node({ price: 60, billing_cycle: "monthly", expires_in: 30 }),
  node({ price: 40, billing_cycle: "monthly", expires_in: -5 }),
]
// 80 yuan of prepaid time, drawn as dollars at the rate the page carries.
assert.deepEqual(residual(plans), { usd: 12, counted: 3, left: 0 })
assert.deepEqual(residual([node({ price: 100, billing_cycle: "once", expires_in: 300 })]), null)
assert.deepEqual(residual([node({ price: 0, expires_in: 300 })]), null)
// An annual plan prorates over its own 360 days, not over a month.
assert.equal(residual([node({ price: 360, billing_cycle: "yearly", expires_in: 90 })])?.usd, 13.5)
console.log("remaining value prorates the time that is left")

// Three currencies, one figure: 60 yuan, 20 euro and 30 dollars are 9.00, 22.42
// and 30 -- the card answers "what is left", which a per-currency listing does
// not.
assert.deepEqual(
  residual([
    node({ price: 30, expires_in: 30 }),
    node({ price: 30, expires_in: 30 }),
    node({ price: 20, currency: "EUR", expires_in: 30 }),
    node({ price: 30, currency: "USD", expires_in: 30 }),
  ]),
  { usd: 61.42, counted: 4, left: 0 },
)
console.log("every currency is converted before it is added")

// A currency the table cannot place is left out and counted, rather than priced
// at par: the total would otherwise contain a number nobody quoted.
assert.deepEqual(residual([node({ price: 30, currency: "XYZ", expires_in: 30 })]), null)
assert.deepEqual(
  residual([node({ price: 30, expires_in: 30 }), node({ price: 30, currency: "XYZ", expires_in: 30 })]),
  { usd: 4.5, counted: 1, left: 1 },
)
console.log("an unpriced currency is counted, not guessed")

// A plan expiring on the boundary is inside the window; one day later is not.
assert.deepEqual(due([node({ expires_in: 30 }), node({ expires_in: 31 }), node({ expires_in: -3 }),
  node({ expires_at: null })]), { soon: 1, expired: 1 })
assert.deepEqual(due([node({ expires_at: "2020-01-01" })]), { soon: 0, expired: 1 })
console.log("expiry inside thirty days, and expiry already past, are counted apart")
