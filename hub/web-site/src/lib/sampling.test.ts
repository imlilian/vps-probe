import assert from "node:assert/strict"

import { bucketFor, metricsPath, pointsFor, renderBudget } from "./sampling.ts"

const load = (hours: number) => [pointsFor(hours, "load"), bucketFor(hours, "load")]
const ping = (hours: number) => [pointsFor(hours, "ping"), bucketFor(hours, "ping")]

assert.deepEqual(load(4), [240, 60], "4 小时 = 1 分钟桶")
assert.deepEqual(load(24), [144, 600], "1 天 = 10 分钟桶")
assert.deepEqual(load(168), [168, 3_600], "7 天 = 1 小时桶")
assert.deepEqual(load(720), [180, 14_400], "30 天 = 4 小时桶")

assert.deepEqual(ping(1), [60, 60], "延迟 1 小时 = 1 分钟桶")
assert.deepEqual(ping(6), [180, 120], "延迟 6 小时 = 2 分钟桶")
assert.deepEqual(ping(12), [144, 300], "延迟 12 小时 = 5 分钟桶")
assert.deepEqual(ping(24), [144, 600], "延迟 1 天 = 10 分钟桶")
assert.deepEqual(ping(168), [168, 3_600], "延迟 7 天 = 1 小时桶")
assert.deepEqual(ping(720), [180, 14_400], "延迟 30 天 = 4 小时桶")

for (const [hours, kind] of [[4, "load"], [24, "load"], [168, "load"], [720, "load"], [6, "ping"], [720, "ping"]] as const) {
  const points = pointsFor(hours, kind)
  const bucket = bucketFor(hours, kind)
  assert.ok(points * bucket >= hours * 3_600, `${kind} ${hours}h must cover the window`)
  assert.ok(points <= 240, `${kind} ${hours}h must stay under the 240-point cap`)
}

assert.equal(bucketFor(5, "load"), 600, "未知范围取下一档，不会更细")
assert.equal(renderBudget(636), 477, "0.75 点/px 兜底")
assert.equal(renderBudget(328), 246, "360px 面板的兜底")

assert.equal(metricsPath(2, 168, "load"), "/nodes/2/metrics?hours=168&points=168&series=metrics", "7 天负载请求")
assert.equal(metricsPath(2, 720, "load"), "/nodes/2/metrics?hours=720&points=180&series=metrics", "30 天负载请求")
assert.equal(metricsPath(2, 6, "ping"), "/nodes/2/metrics?hours=6&points=180&series=ping", "6 小时延迟请求")

console.log("sampling: time buckets cover every range and stay under 240 points")
