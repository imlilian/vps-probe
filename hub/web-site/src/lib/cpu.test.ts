import assert from "node:assert/strict"

import { cpuRating, passMarkUrl } from "./cpu.ts"

const tier = (name: string) => cpuRating(name).tier
const label = (name: string) => cpuRating(name).label

assert.equal(tier("AMD EPYC 9654 96-Core Processor"), "S", "EPYC 9004 是旗舰")
assert.equal(label("AMD EPYC 9654 96-Core Processor"), "旗舰服务器级", "服务器语境")
assert.equal(cpuRating("AMD EPYC 9654 96-Core Processor").percent, 92, "S 的条是 92%")

assert.equal(tier("Intel Xeon Gold 5118 CPU @ 2.30GHz"), "B", "Gold 5xxx 是中端")
assert.equal(label("Intel Xeon Gold 5118 CPU @ 2.30GHz"), "中端服务器级", "服务器语境")

assert.equal(tier("AMD Ryzen 9 7950X 16-Core Processor"), "A", "Ryzen 9 是高性能")
assert.equal(label("AMD Ryzen 9 7950X 16-Core Processor"), "高端消费级", "消费语境")

assert.equal(tier("Intel Xeon E5-2680 v3 @ 2.50GHz"), "C", "E5 v3 是较旧平台")
assert.equal(label("Intel Xeon E5-2680 v3 @ 2.50GHz"), "入门服务器级", "服务器语境")

assert.equal(tier("Ampere Altra"), "B", "ARM 云平台有保守分级")
assert.equal(label("Ampere Altra"), "云原生 ARM 级", "ARM 语境")

assert.equal(tier("Intel Celeron N5105"), "B", "低功耗仍给保守中端")
assert.equal(tier(""), "?", "空型号未收录")
assert.equal(label(""), "未收录", "未收录标签")
assert.equal(cpuRating("").percent, 0, "未收录条为空")

assert.match(passMarkUrl("AMD EPYC 9654"), /cpu_lookup\.php\?cpu=AMD%20EPYC%209654/, "PassMark 查询")
assert.equal(passMarkUrl(""), "https://www.cpubenchmark.net/cpu-list/all", "空型号回列表")

console.log("cpu tier: server, consumer, arm, unknown")
