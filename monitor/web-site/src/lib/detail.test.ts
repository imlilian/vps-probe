// The detail page's arithmetic, without a browser. Run with `npm test`.
import assert from "node:assert/strict"

import type { Node } from "./api.ts"
import {
  detailBytes, detailRate, diskForecast, expiryDays, expiryTone, monthlyCost, peakOf,
  remainingTime, remainingValue, trafficPct, trafficUsed, uptimeLong,
} from "./detail.ts"

const node = (over: Partial<Node>) => over as unknown as Node

assert.equal(monthlyCost(node({ price: 30, billing_cycle: "monthly" })), 30, "月付就是原价")
assert.equal(monthlyCost(node({ price: 30, billing_cycle: "quarterly" })), 10, "季付摊到三个月")
assert.equal(monthlyCost(node({ price: 30, billing_cycle: "yearly" })), 2.5, "年付摊到十二个月")
assert.equal(monthlyCost(node({ price: 30, billing_cycle: "once" })), null, "一次性没有月均")
assert.equal(monthlyCost(node({ price: 0, billing_cycle: "monthly" })), 0, "免费是 0，不是未知")

assert.equal(expiryDays(node({ expires_in: 12 })), 12, "hub 的天数优先")
const dated = expiryDays(node({ expires_in: undefined, expires_at: "2027-03-17T00:00:00Z" }))
assert.ok(dated !== null && dated > 0, "没有 expires_in 时按日期；完整 ISO 不能读成空")
assert.equal(remainingTime(node({ expires_in: 1000 })).value, "1000", "剩余天数")
assert.equal(remainingTime(node({ expires_in: 1000 })).unit, "天", "单位是天")
assert.equal(remainingTime(node({ expires_in: 7 })).tone, "warn", "一周内是警告色")
assert.equal(remainingTime(node({ expires_in: 3 })).tone, "danger", "五天是紧迫色")
assert.equal(remainingTime(node({ expires_in: -2 })).value, "已过期 2", "过期天数")
assert.equal(remainingTime(node({ expires_in: null, expires_at: null })).value, "永久", "无到期是永久")
assert.equal(remainingTime(node({ expires_in: 0 })).value, "今天", "今天到期是词")

const planned = (over: Partial<Node>) => node({ price: 99, billing_cycle: "triennial", expires_in: 1000, ...over })
assert.equal(remainingValue(planned({})), (99 * 1000) / 1095, "剩余价值按天数摊，三年是 1095 天")
assert.equal(remainingValue(planned({ expires_in: 0 })), 0, "到期后没有剩余价值")
assert.equal(remainingValue(planned({ expires_in: null, expires_at: null })), null, "无到期日不算")
assert.equal(remainingValue(planned({ price: 0 })), null, "免费没有剩余价值")
assert.equal(remainingValue(planned({ billing_cycle: "once" })), 99, "一次性按全额")
// The same arithmetic as the overview card: a plan dated past one cycle was paid
// for past one cycle, so it is not capped at the price of one.
assert.equal(remainingValue(planned({ billing_cycle: "yearly", expires_in: 636 })), (99 * 636) / 365, "预付款超过一个周期不封顶")
assert.equal(remainingValue(planned({ billing_cycle: "yearly", expires_in: 100_000 })), 99, "百年以上的到期日按全额")

assert.equal(trafficUsed(node({ month_used: 500, month_rx: 1, month_tx: 1 })), 500, "hub 的 month_used 优先")
assert.equal(trafficUsed(node({ month_used: undefined, month_rx: 3, month_tx: 5, traffic_mode: "up" })), 5, "老 hub 按 UP 计")
assert.equal(trafficUsed(node({ month_used: undefined, month_rx: 3, month_tx: 5, traffic_mode: "max" })), 5, "老 hub 按 MAX 计")
assert.equal(trafficPct(node({ month_used: 500, traffic_limit: 1000 })), 50, "一半配额")
assert.equal(trafficPct(node({ month_used: 500, traffic_limit: 0 })), null, "无上限是 null")
assert.equal(trafficPct(node({ month_used: 2000, traffic_limit: 1000 })), 100, "超额封顶 100")

assert.equal(uptimeLong(0), "0 秒", "零秒")
assert.equal(uptimeLong(30), "不足 1 分钟", "不足一分钟")
assert.equal(uptimeLong(90), "1 分钟", "一分钟以上")
assert.equal(uptimeLong(3661), "1 小时 1 分钟", "小时与分钟")
assert.equal(uptimeLong(90_000), "1 天 1 小时 0 分钟", "天与小时")

assert.equal(detailBytes(1024), "1 KB", "KB 不带小数")
assert.equal(detailBytes(1.5 * 1024 ** 2), "1.5 MB", "MB 一位小数")
assert.equal(detailBytes(1024 ** 3), "1.0 GB", "GB 一位小数")
assert.equal(detailBytes(2.34 * 1024 ** 4), "2.34 TB", "TB 两位小数")
assert.equal(detailBytes(894 * 1024), "894 KB", "KB 整数")
assert.equal(detailRate(894 * 1024), "894 KB/s", "速率带 /s")

assert.deepEqual(peakOf([{ net_rx_max: 10, net_tx_max: 5 }, { net_rx: 20, net_tx: 1 }]), { rx: 20, tx: 5 }, "峰值取最大")
assert.equal(peakOf([{ net_rx: 0, net_tx: 0 }]), null, "全零不是峰值")

assert.equal(expiryTone(null), "muted", "无到期 muted")
assert.equal(expiryTone(400), "ok", "正常 ok")
assert.equal(expiryTone(-1), "danger", "过期 danger")

const day = 86_400_000
assert.equal(diskForecast([{ ts: 0, disk_used: 10 }, { ts: day, disk_used: 20 }], 100), "预计 8 天后满", "线性写满预测")
assert.equal(diskForecast([{ ts: 0, disk_used: 20 }, { ts: day, disk_used: 20 }], 100), null, "不涨不预测")
assert.equal(diskForecast([{ ts: 0, disk_used: 101 }, { ts: day, disk_used: 102 }], 100), "预计已满", "已满")
assert.equal(diskForecast([{ ts: 0, disk_used: 10 }], 100), null, "一个点不够")
assert.equal(diskForecast([{ ts: 0, disk_used: 10 }, { ts: day, disk_used: 20 }], 0), null, "没有总量不预测")

console.log("detail arithmetic: costs, expiry, traffic, uptime, bytes, peaks")
