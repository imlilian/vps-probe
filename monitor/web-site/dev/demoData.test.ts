// The dev mock has to answer the same shapes the hub does, or the page is
// polished against a fiction. These pin the time buckets, the gap and the
// pre-1.4.1 omissions the detail page has to degrade gracefully around.
import assert from "node:assert/strict"

import { history, nodeList, SITE_NAME } from "./demoData.ts"

const now = Date.UTC(2026, 9, 28, 12, 30)
const span = (hours: number, points: number) => {
  const answer = history(2, "metrics", hours, points, now)
  return { step: answer.step, rows: answer.metrics.length, answer }
}

assert.equal(span(4, 240).step, 60, "4h is one-minute buckets")
assert.equal(span(24, 144).step, 600, "1d is ten-minute buckets")
assert.equal(span(168, 168).step, 3_600, "7d is hourly buckets")
assert.equal(span(720, 180).step, 14_400, "30d is four-hour buckets")
assert.ok(span(168, 168).rows >= 168, "7d covers the requested week")
assert.ok(span(720, 180).rows >= 180, "30d covers the requested month")

const legacy = history(1, "metrics", 168, 168, now).metrics[0]!
for (const field of ["swap_used", "tcp", "udp", "procs", "net_rx_max", "cpu_max", "minutes"]) {
  assert.ok(!(field in legacy), `legacy hub omits ${field}`)
}
assert.ok(nodeList(now).find((node) => node.id === 1)?.agent_version === "1.2.0", "legacy node says so")

const gapped = history(4, "metrics", 168, 168, now).metrics
let holes = 0
for (let i = 1; i < gapped.length; i++) if (gapped[i]!.ts - gapped[i - 1]!.ts > 3_600 * 1.5) holes++
assert.ok(holes === 1, "the maintenance window is one gap")

const ping = history(2, "ping", 6, 180, now)
assert.equal(ping.step, 120, "6h latency is two-minute buckets")
assert.ok(Object.keys(ping.probes).length > 0, "probe names travel with the samples")
assert.ok(Object.keys(ping.loss).length >= 0, "loss object is present")

// The retransmit figures a current hub sends: a window rate per probe, and a
// per-bucket one only where it happened -- zero is left out, as the hub does.
assert.ok(ping.retx !== undefined, "a current hub answers with the retransmit map")
const rates = Object.values(ping.retx)
assert.ok(rates.length > 0 && rates.every((rate) => rate > 0 && rate <= 100), "rates are percentages")
const flagged = ping.ping.filter((row) => "retx" in row)
assert.ok(flagged.length > 0, "a congested line marks buckets, so the strip has dots to draw")
assert.ok(flagged.every((row) => (row.retx as number) > 0), "a zero is an absent key, never a stored zero")

// A hub from before the metric: no key at all, on the answer or on any row.
{
  const old = history(1, "ping", 6, 180, now)
  assert.ok(!("retx" in old), "an old hub answers without the retransmit map")
  assert.ok(old.ping.length > 0, "and still has samples to draw")
  assert.ok(old.ping.every((row) => !("retx" in row)), "with no bucket marked")
}

assert.ok(SITE_NAME.length > 0, "the mock names its site")

console.log("demo data: hub-shaped buckets, gaps, legacy omissions")
