/// <reference types="node" />
// The list's ordering, called directly: no browser, no DOM. Every case here is a
// question a visitor can ask of the page, answered against a fleet built to have
// an answer.
import assert from "node:assert/strict"

import type { Metrics, Node } from "./api.ts"
import { arrange, DEFAULT_ORDER, formatOrder, nextOrder, parseOrder, SORTS, type Order } from "./sort.ts"

const metrics = (over: Partial<Metrics> = {}): Metrics => ({
  uptime: 3600, cpu: 10, load: [0.1, 0.1, 0.1], mem_total: 100, mem_used: 10,
  swap_total: 0, swap_used: 0, disk_total: 100, disk_used: 10, net_rx: 0, net_tx: 0,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, tcp: 0, udp: 0, procs: 0, ...over,
})

const node = (over: Partial<Node>): Node => ({
  id: 1, name: "节点", sort: 0, public: true, online: true, country: "HK", group: "",
  last_seen: 0, last_seen_ago: 0, metrics: metrics(), os: "", kernel: "", arch: "", virt: "",
  cpu_name: "", cpu_cores: 2, mem_total: 0, swap_total: 0, disk_total: 0, agent_version: "",
  price: 0, currency: "CNY", billing_cycle: "once", expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: "sum", traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: "", day_rx: 0, day_tx: 0,
  ...over,
})

const names = (nodes: Node[]) => nodes.map((n) => n.name).join(",")
const order = (key: Order["key"], dir: Order["dir"]): Order => ({ key, dir })

// 默认 is the operator's order, which is what every other key falls back on.
const fleet: Node[] = [
  node({ id: 1, sort: 2, name: "香港-CN2-01", country: "HK", metrics: metrics({ cpu: 18 }) }),
  node({ id: 2, sort: 0, name: "洛杉矶-CN2-GIA", country: "US", metrics: metrics({ cpu: 68 }) }),
  node({ id: 3, sort: 1, name: "东京-BGP-01", country: "JP", metrics: metrics({ cpu: 31 }) }),
  node({ id: 4, sort: 3, name: "广州-测试机", country: "CN", online: false, metrics: null }),
]
assert.equal(names(arrange(fleet, DEFAULT_ORDER)), "洛杉矶-CN2-GIA,东京-BGP-01,香港-CN2-01,广州-测试机")
console.log("默认 keeps the operator's order")

// A Chinese collator, so the list reads the way the names sound rather than by
// code point; `numeric` so a tenth machine does not come before the second.
const byName = arrange([
  node({ id: 1, sort: 0, name: "香港-CN2-10" }),
  node({ id: 2, sort: 1, name: "香港-CN2-2" }),
  node({ id: 3, sort: 2, name: "新加坡-01" }),
  node({ id: 4, sort: 3, name: "法兰克福-01" }),
], order("name", "asc"))
assert.equal(names(byName), "法兰克福-01,香港-CN2-2,香港-CN2-10,新加坡-01")
assert.equal(names(arrange(byName, order("name", "desc"))), "新加坡-01,香港-CN2-10,香港-CN2-2,法兰克福-01")
console.log("名称 sorts by reading, and reverses")

// 地区 gathers a country's machines together -- the thing a row of flags was
// asked to do as a filter, without hiding the rest of the fleet.
const regions = arrange([
  node({ id: 1, sort: 0, name: "香港-1", country: "HK" }),
  node({ id: 2, sort: 1, name: "美国-1", country: "US" }),
  node({ id: 3, sort: 2, name: "香港-2", country: "HK" }),
  node({ id: 4, sort: 3, name: "德国-1", country: "DE" }),
  node({ id: 5, sort: 4, name: "未知-1", country: "" }),
], order("country", "asc"))
assert.equal(names(regions), "德国-1,美国-1,香港-1,香港-2,未知-1")
assert.equal(regions.at(-1)!.name, "未知-1", "a node the hub could not place goes last")
console.log("地区 groups a country and pushes the unplaced to the end")

// A live figure: busiest first, and the machine that is not reporting last --
// not at 0%, which would read as idle.
assert.equal(names(arrange(fleet, order("cpu", "desc"))), "洛杉矶-CN2-GIA,东京-BGP-01,香港-CN2-01,广州-测试机")
assert.equal(names(arrange(fleet, order("cpu", "asc"))), "香港-CN2-01,东京-BGP-01,洛杉矶-CN2-GIA,广州-测试机")
console.log("CPU ranks the busiest first and an offline node last either way")

const measured = [
  node({ id: 1, sort: 0, name: "内存", metrics: metrics({ mem_total: 100, mem_used: 92 }) }),
  node({ id: 2, sort: 1, name: "硬盘", metrics: metrics({ disk_total: 100, disk_used: 71 }) }),
  node({ id: 3, sort: 2, name: "速率", metrics: metrics({ net_rx: 5_000_000, net_tx: 2_000_000 }) }),
  node({ id: 4, sort: 3, name: "在线", metrics: metrics({ uptime: 90 * 86400 }) }),
  node({ id: 5, sort: 4, name: "空闲", metrics: metrics() }),
]
for (const [key, winner] of [["mem", "内存"], ["disk", "硬盘"], ["rate", "速率"], ["uptime", "在线"]] as const) {
  assert.equal(arrange(measured, order(key, "desc"))[0]!.name, winner, `${key} ranks ${winner} first`)
}
console.log("内存 / 硬盘 / 速率 / 在线 each rank their own figure")

// Today's counters survive the machine going away, so this key ranks offline
// nodes too -- a box that moved 40 GB today is not a box with no figure.
const today = [
  node({ id: 1, sort: 0, name: "离线但忙", online: false, metrics: null, day_rx: 30e9, day_tx: 10e9 }),
  node({ id: 2, sort: 1, name: "在线但闲", day_rx: 1e9, day_tx: 1e9 }),
]
assert.equal(names(arrange(today, order("today", "desc"))), "离线但忙,在线但闲")
console.log("流量 ranks by the hub's daily counters, online or not")

// Prices are in three currencies: compared as quoted, ¥4800 (JPY) would sit at
// the top of a dollar fleet. They are converted first, the way the bill card
// already converts them.
const priced = [
  node({ id: 1, sort: 0, name: "日元", price: 4800, currency: "JPY" }), // ~US$31
  node({ id: 2, sort: 1, name: "美元", price: 89, currency: "USD" }),
  node({ id: 3, sort: 2, name: "人民币", price: 100, currency: "CNY" }), // ~US$15
  node({ id: 4, sort: 3, name: "免费", price: 0, currency: "CNY" }),
  node({ id: 5, sort: 4, name: "怪币种", price: 50, currency: "XYZ" }),
]
assert.equal(names(arrange(priced, order("price", "desc"))), "美元,日元,人民币,免费,怪币种")
console.log("价格 compares currencies on one scale and leaves the unpriced last")

// Expiry opens at the urgent end: overdue, then the soonest, then nothing at
// all -- a machine with no date is not "expires in 0 days".
const now = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
const expiring = [
  node({ id: 1, sort: 0, name: "已过期", expires_in: -3 }),
  node({ id: 2, sort: 1, name: "七月后", expires_in: 212 }),
  node({ id: 3, sort: 2, name: "永不到期", expires_in: null }),
  node({ id: 4, sort: 3, name: "七天", expires_in: 7 }),
  // A hub from before `expires_in`: the browser counts from `expires_at`.
  node({ id: 5, sort: 4, name: "五日", expires_in: undefined, expires_at: now }),
]
const byExpiry = arrange(expiring, order("expiry", "asc"))
assert.deepEqual(byExpiry.slice(0, 2).map((n) => n.name).sort(), ["已过期", "五日"].sort())
assert.equal(byExpiry[2]!.name, "七天")
assert.equal(byExpiry.at(-1)!.name, "永不到期")
console.log("到期 puts the overdue first and the undated last")

// Equal figures keep the operator's order, so two nodes at the same percentage
// do not swap places between frames.
const tied = [
  node({ id: 7, sort: 1, name: "后", metrics: metrics({ cpu: 50 }) }),
  node({ id: 3, sort: 0, name: "先", metrics: metrics({ cpu: 50 }) }),
]
const first = arrange(tied, order("cpu", "desc"))
assert.equal(names(first), "先,后")
assert.equal(names(arrange([...first].reverse(), order("cpu", "desc"))), "先,后", "input order does not decide a tie")
console.log("a tie holds the operator's order")

// The caller's array is left alone: the page re-sorts the same pushed list every
// time an arrow is pressed.
const untouched = [...fleet]
arrange(untouched, order("cpu", "desc"))
assert.deepEqual(untouched.map((n) => n.id), fleet.map((n) => n.id))
console.log("arranging does not reorder the caller's list")

// The control's state machine: a new key opens in its own direction, the same
// key turns around.
assert.deepEqual(nextOrder(DEFAULT_ORDER, "cpu"), { key: "cpu", dir: "desc" })
assert.deepEqual(nextOrder({ key: "cpu", dir: "desc" }, "name"), { key: "name", dir: "asc" })
assert.deepEqual(nextOrder({ key: "cpu", dir: "desc" }, "cpu"), { key: "cpu", dir: "asc" })
assert.deepEqual(nextOrder({ key: "cpu", dir: "asc" }, "cpu"), { key: "cpu", dir: "desc" })
console.log("a new key opens its own way; the same key reverses")

// What comes back out of storage is user input: anything unrecognised is the
// default rather than a page with no order at all.
assert.equal(SORTS.length, 11)
assert.deepEqual(parseOrder(null), DEFAULT_ORDER)
assert.deepEqual(parseOrder("nonsense"), DEFAULT_ORDER)
assert.deepEqual(parseOrder("cpu"), { key: "cpu", dir: "desc" })
assert.deepEqual(parseOrder("cpu:asc"), { key: "cpu", dir: "asc" })
assert.deepEqual(parseOrder("name:sideways"), { key: "name", dir: "asc" })
assert.equal(formatOrder(parseOrder(formatOrder({ key: "mem", dir: "desc" }))), "mem:desc")
console.log("a stored order survives a round trip and refuses anything else")
