import assert from "node:assert/strict"

import type { Metrics } from "./api.ts"
import { appendLive, frameStamp, LIVE_CAP, type LiveRow } from "./live.ts"

const metrics = (cpu: number): Metrics => ({
  uptime: 1, cpu, load: [0, 0, 0], mem_total: 1, mem_used: 1, swap_total: 0, swap_used: 0,
  disk_total: 1, disk_used: 1, net_rx: 1, net_tx: 2, total_rx: 0, total_tx: 0,
  month_rx: 0, month_tx: 0, tcp: 1, udp: 2, procs: 3,
})

let rows: LiveRow[] = []
for (let i = 0; i < LIVE_CAP + 10; i++) rows = appendLive(rows, metrics(i), i * 2_000)
assert.equal(rows.length, LIVE_CAP, "the buffer is five minutes wide")
assert.equal(rows.at(-1)?.cpu, LIVE_CAP + 9, "the newest sample is kept")

const replaced = appendLive(rows, metrics(999), rows.at(-1)!.ts)
assert.equal(replaced.length, LIVE_CAP, "a duplicate timestamp does not grow the buffer")
assert.equal(replaced.at(-1)?.cpu, 999, "and replaces the last reading")

const first = appendLive([], metrics(1), 0)
assert.deepEqual(first, [{
  ts: 0, cpu: 1, mem_used: 1, swap_used: 0, disk_used: 1,
  net_rx: 1, net_tx: 2, tcp: 1, udp: 2, procs: 3,
}], "one sample carries every live metric")

// The frame's own millisecond is what a sample is drawn at, so that the newest
// points share a clock with the history buckets behind them.
assert.equal(frameStamp(1_790_000_000_000), 1_790_000_000_000, "the hub's stamp is used as it arrives")
const floored = frameStamp(0)
assert.ok(Math.abs(floored - Date.now()) < 5_000, "a hub that does not say falls back to the wall clock")

// One frame sampled twice -- the hub caches a frame for just under its push
// interval, so two messages can carry the same stamp. It replaces the last
// reading rather than drawing two points on one x.
const stamped = appendLive([], metrics(5), 1_790_000_000_000)
const twice = appendLive(stamped, metrics(6), 1_790_000_000_000)
assert.equal(twice.length, 1, "a repeated frame does not grow the buffer")
assert.equal(twice[0]!.cpu, 6, "and keeps the newer reading")
const next = appendLive(twice, metrics(7), 1_790_000_002_000)
assert.equal(next.length, 2, "the next frame appends")
assert.deepEqual(next.map((row) => row.ts), [1_790_000_000_000, 1_790_000_002_000], "two seconds apart")

console.log("live buffer: capped, ordered, deduped, stamped by the hub")
