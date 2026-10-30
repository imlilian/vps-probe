import assert from "node:assert/strict"

import { buildLatencyRows, interpolateShortGaps, probeStats, type PingPoint, type ProbeSeries } from "./pingDetail.ts"

const points = (values: (number | null)[], loss = 0): PingPoint[] =>
  values.map((latency, i) => ({ task_id: 1, ts: i * 60_000, latency, loss }))

const series = (values: (number | null)[], loss = 0): ProbeSeries => ({
  id: 1, name: "上海电信", points: points(values, loss), loss,
})

const stat = probeStats(series([10, 20, 30, 40], 2.5))
assert.equal(stat.avg, 25, "平均是桶中位数的均值")
assert.equal(stat.latest, 40, "最新是最后一个非空值")
assert.equal(stat.min, 10, "最小")
assert.equal(stat.max, 40, "最大")
assert.equal(stat.p50, 25, "P50")
assert.ok(stat.p99 !== null && stat.p99 > 39 && stat.p99 < 40, "P99 线性插值")
assert.ok(stat.volatility !== null && stat.volatility > 1.5 && stat.volatility < 1.6, "波动率 P99/P50")
assert.equal(stat.loss, 2.5, "窗口丢包来自 hub")
assert.equal(stat.samples, 4, "样本数")

assert.equal(stat.retx, null, "旧 hub 没有窗口重传率")
const retxed = probeStats({ ...series([10, 20], 0), retx: 4.7 })
assert.equal(retxed.retx, 4.7, "窗口重传率来自 hub，与丢包同源")
assert.equal(probeStats({ ...series([10]), retx: 0 }).retx, 0, "零是读数：这一窗没有重传")

const empty = probeStats(series([null, null]))
assert.equal(empty.avg, null, "全超时为 null")
assert.equal(empty.volatility, null, "没有 P50 就没有波动率")

const gap: PingPoint[] = [
  { task_id: 1, ts: 0, latency: 10 },
  { task_id: 1, ts: 60_000, latency: null },
  { task_id: 1, ts: 120_000, latency: 30 },
  { task_id: 1, ts: 5_400_000, latency: null },
  { task_id: 1, ts: 5_460_000, latency: 50 },
]
const filled = interpolateShortGaps(gap, 60_000)
assert.equal(filled[1]!.latency, 20, "一分钟的洞按线性插值")
assert.equal(filled[3]!.latency, null, "一个半小时的洞保持断开")

const rows = buildLatencyRows([
  series([10, null, 30]),
  { id: 2, name: "上海联通", points: [{ task_id: 2, ts: 0, latency: 40, band: [35, 45] }, { task_id: 2, ts: 120_000, latency: 60 }], loss: 0 },
], false, 60_000)
assert.equal(rows.length, 3, "按时间合并")
assert.equal(rows[1]!["t1"], 20, "短洞被补齐")
assert.deepEqual(rows[0]!["b2"], [35, 45], "band 原样带过")
assert.equal(rows[0]!["l1"], 0, "每桶丢包")

console.log("ping detail: stats, short-gap interpolation, row merge")
