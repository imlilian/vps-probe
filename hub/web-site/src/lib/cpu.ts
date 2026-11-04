import { cpuName } from "./format.ts"

export type CpuTier = "S" | "A" | "B" | "C" | "D" | "?"

export type CpuRating = {
  tier: CpuTier
  /** Contextual label such as 旗舰服务器级 / 高端消费级. */
  label: string
  /** How full the bar is: 92 / 76 / 58 / 38 / 20 / 0. */
  percent: number
  /** What the tier means, for the bar's tooltip. */
  description: string
}

const TIER: Record<CpuTier, Omit<CpuRating, "tier" | "label">> = {
  S: { percent: 92, description: "近代旗舰或高密度计算平台" },
  A: { percent: 76, description: "近代高性能服务器或桌面平台" },
  B: { percent: 58, description: "仍具实用价值的主流平台" },
  C: { percent: 38, description: "较早代际或偏低功耗平台" },
  D: { percent: 20, description: "入门、低功耗或老旧平台" },
  "?": { percent: 0, description: "型号不足以完成本地近似分级" },
}

const SERVER = /\b(EPYC|XEON|OPTERON|POWER\d+)\b/
const CONSUMER = /\b(CORE|RYZEN|THREADRIPPER|CELERON|PENTIUM|ATHLON)\b/
const CLOUD_ARM = /\b(AMPERE|ALTRA|GRAVITON|NEOVERSE|KUNPENG|THUNDERX|PHYTIUM)\b/

function label(tier: CpuTier, kind: "server" | "consumer" | "arm" | "generic"): string {
  const index = { S: 0, A: 1, B: 2, C: 3, D: 4, "?": 5 }[tier]
  if (tier === "?") return "未收录"
  const server = ["旗舰服务器级", "高端服务器级", "中端服务器级", "入门服务器级", "老旧服务器级"]
  const consumer = ["旗舰消费级", "高端消费级", "中端消费级", "入门消费级", "老旧消费级"]
  const arm = ["旗舰云计算级", "高端云计算级", "云原生 ARM 级", "入门 ARM 级", "老旧 ARM 级"]
  if (kind === "server") return server[index] ?? "服务器级"
  if (kind === "consumer") return consumer[index] ?? "消费级"
  if (kind === "arm") return arm[index] ?? "云计算级"
  return "通用"
}

function rating(tier: CpuTier, kind: "server" | "consumer" | "arm" | "generic"): CpuRating {
  return { tier, label: label(tier, kind), ...TIER[tier] }
}

function epyc(name: string): CpuRating | null {
  // EPYC models are mostly digits, but the cloud parts carry a letter in the
  // middle (7B13); the digits are what say which generation it is.
  const match = name.match(/\bEPYC\s+([0-9][A-Z0-9-]{2,7})/)
  if (!match) return null
  const digits = match[1]!.replace(/\D/g, "")
  if (!digits) return null
  if (digits[0] === "9" || digits[0] === "8") return rating("S", "server")
  const generation = digits.at(-1)
  if (generation === "3") return rating("A", "server")
  if (generation === "2") return rating("B", "server")
  if (generation === "1") return rating("C", "server")
  return rating("B", "server")
}

function xeonScalable(name: string): CpuRating | null {
  const match = name.match(/\bXEON\s+(PLATINUM|GOLD|SILVER|BRONZE)\s+(\d{4,5})/)
  if (!match) return null
  const family = match[1]!
  const sku = match[2]!
  if (family === "PLATINUM") return rating("S", "server")
  if (family === "GOLD") return rating(sku.startsWith("6") ? "A" : "B", "server")
  if (family === "SILVER") return rating("B", "server")
  return rating("C", "server")
}

function xeonE(name: string): CpuRating | null {
  const match = name.match(/\bE[57]-\d{4}\s*V(\d)/)
  if (!match) return null
  return rating(Number(match[1]) >= 3 ? "C" : "D", "server")
}

function ryzen(name: string): CpuRating | null {
  if (/\bTHREADRIPPER\b/.test(name)) return rating("A", "consumer")
  const match = name.match(/\bRYZEN\s+([3579])/)
  if (!match) return null
  const family = Number(match[1])
  return rating(family === 9 ? "A" : family === 3 ? "C" : "B", "consumer")
}

function core(name: string): CpuRating | null {
  const match = name.match(/\bCORE\s+I([3579])/)
  if (!match) return null
  const family = Number(match[1])
  return rating(family === 9 ? "A" : family === 3 ? "C" : "B", "consumer")
}

/**
 * A local, model-generation estimate of where a CPU sits. It is deliberately
 * not a benchmark: no data is fetched, no score is stored, and the label says
 * "参考分级" so a visitor does not read it as this machine's measured result.
 */
export function cpuRating(name: string): CpuRating {
  const clean = cpuName(name ?? "").toUpperCase()
  if (!clean) return rating("?", "generic")
  const kind = CLOUD_ARM.test(clean) ? "arm" : SERVER.test(clean) ? "server" : CONSUMER.test(clean) ? "consumer" : "generic"
  const found = epyc(clean) ?? xeonScalable(clean) ?? xeonE(clean) ?? ryzen(clean) ?? core(clean)
  if (found) return found
  if (kind === "arm") return rating("B", "arm")
  if (kind === "server") return rating("B", "server")
  if (kind === "consumer") return rating("B", "consumer")
  return rating("?", "generic")
}

/** A PassMark lookup for the model, or their full list when the name is empty. */
export function passMarkUrl(name: string): string {
  const clean = cpuName(name ?? "").replace(/\s*@.*$/, "").trim()
  return clean
    ? `https://www.cpubenchmark.net/cpu_lookup.php?cpu=${encodeURIComponent(clean)}`
    : "https://www.cpubenchmark.net/cpu-list/all"
}
