import assert from "node:assert/strict"

import type { Metrics } from "./api.ts"
import { appendLive, LIVE_CAP, type LiveRow } from "./live.ts"

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

console.log("live buffer: capped, ordered, deduped")
