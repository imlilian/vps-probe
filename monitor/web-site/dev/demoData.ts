/**
 * Sample data for `npm run dev:mock`: eight nodes shaped like a real fleet, and
 * probe histories that make the latency panel show something worth looking at.
 *
 * Everything here is a pure function of the wall clock, so two requests for the
 * same window agree, a reload does not reshuffle the past, and the panel's
 * colours stay put while it polls. The shapes are the hub's own (`src/db.rs`,
 * `src/api.rs`), which is the point: the page under the mock is the page that
 * ships, and nothing in `src/` knows this file exists.
 */

export const SITE_NAME = "VPS Probe 演示"

/** The probes an operator would have configured in the panel, in id order. */
export const PROBES: { id: number; name: string }[] = [
  { id: 1, name: "上海电信" },
  { id: 2, name: "上海联通" },
  { id: 3, name: "上海移动" },
  { id: 4, name: "北京电信" },
  { id: 5, name: "广州移动" },
]

/**
 * How one probe on one node behaves. `congested` and `lossy` are the two ways a
 * line goes bad in practice -- everything slows down, or a slice of the traffic
 * never arrives -- and the panel has to make both obvious at a glance.
 */
type Profile = "good" | "congested" | "lossy" | "flaky"

type Spec = {
  id: number
  name: string
  country: string
  group: string
  os: string
  kernel: string
  arch: string
  virt: string
  cpuName: string
  cores: number
  mem: number
  disk: number
  price: number
  /** The currency the price is billed in; the table's default is CNY. */
  currency?: string
  cycle: string
  expiresIn: number | null
  trafficLimit: number
  trafficMode: string
  /** Percent of the month's allowance already used. */
  monthUsed: number
  rxBase: number
  txBase: number
  cpuBase: number
  cpuAmp: number
  memPct: number
  diskPct: number
  tcp: number
  udp: number
  procs: number
  uptime: number
  probes: number[]
  profiles?: Record<number, Profile>
  /** A note an operator would write for visitors; most nodes have none. */
  publicRemark?: string
  online: boolean
}

const GiB = 1024 ** 3
const MiB = 1024 ** 2

/**
 * Eight nodes, each one covering a case the page must handle: three probes
 * (the design case), fewer than three, more than three, a bad line on an
 * otherwise healthy node, an offline node, and a plan nearly out of traffic.
 */
const SPECS: Spec[] = [
  {
    id: 1, name: "香港-CN2-01", country: "HK", group: "香港",
    os: "Debian 12", kernel: "6.1.0-28-amd64", arch: "x86_64", virt: "KVM",
    cpuName: "Intel Xeon E5-2680 v4", cores: 2, mem: 2 * GiB, disk: 40 * GiB,
    price: 29.9, cycle: "monthly", expiresIn: 212, trafficLimit: 500 * GiB, trafficMode: "sum",
    monthUsed: 0.38, rxBase: 2.6 * MiB, txBase: 5.4 * MiB,
    cpuBase: 18, cpuAmp: 9, memPct: 0.46, diskPct: 0.31,
    tcp: 96, udp: 14, procs: 132, uptime: 92 * 86400, probes: [1, 2, 3], online: true,
    publicRemark: "CN2 GIA 回程，晚高峰偶有拥塞。限速 100 Mbps。",
  },
  {
    id: 2, name: "香港-CN2-02", country: "HK", group: "香港",
    os: "Debian 12", kernel: "6.1.0-28-amd64", arch: "x86_64", virt: "KVM",
    cpuName: "AMD EPYC 7B13", cores: 4, mem: 4 * GiB, disk: 80 * GiB,
    price: 59.9, cycle: "monthly", expiresIn: 7, trafficLimit: 1000 * GiB, trafficMode: "sum",
    monthUsed: 0.71, rxBase: 6.8 * MiB, txBase: 11.2 * MiB,
    cpuBase: 47, cpuAmp: 16, memPct: 0.63, diskPct: 0.44,
    tcp: 412, udp: 38, procs: 268, uptime: 41 * 86400, probes: [1, 2, 3],
    // The line this whole feature exists for: 上海移动 回国 is congested.
    profiles: { 3: "congested" }, online: true,
    publicRemark: "上海移动方向近期丢包偏高，已报运营商。",
  },
  {
    id: 3, name: "东京-BGP-01", country: "JP", group: "日本",
    os: "Ubuntu 24.04", kernel: "6.8.0-45-generic", arch: "x86_64", virt: "KVM",
    cpuName: "Intel Xeon Gold 6248", cores: 2, mem: 2 * GiB, disk: 40 * GiB,
    price: 4800, currency: "JPY", cycle: "monthly", expiresIn: 21, trafficLimit: 300 * GiB, trafficMode: "max",
    monthUsed: 0.86, rxBase: 4.1 * MiB, txBase: 7.9 * MiB,
    cpuBase: 31, cpuAmp: 12, memPct: 0.52, diskPct: 0.28,
    tcp: 188, udp: 22, procs: 174, uptime: 12 * 86400, probes: [1, 2, 3],
    profiles: { 2: "lossy" }, online: true,
  },
  {
    id: 4, name: "洛杉矶-CN2-GIA", country: "US", group: "美国",
    os: "Debian 12", kernel: "6.1.0-26-amd64", arch: "x86_64", virt: "KVM",
    cpuName: "AMD EPYC 7402P", cores: 4, mem: 8 * GiB, disk: 160 * GiB,
    price: 89, currency: "USD", cycle: "monthly", expiresIn: 143, trafficLimit: 2000 * GiB, trafficMode: "sum",
    monthUsed: 0.55, rxBase: 9.4 * MiB, txBase: 3.1 * MiB,
    cpuBase: 68, cpuAmp: 14, memPct: 0.71, diskPct: 0.62,
    tcp: 634, udp: 51, procs: 341, uptime: 7 * 86400, probes: [1, 2, 3],
    profiles: { 1: "lossy" }, online: true,
  },
  {
    id: 5, name: "新加坡-01", country: "SG", group: "新加坡",
    os: "Alpine 3.20", kernel: "6.6.44-0-lts", arch: "aarch64", virt: "KVM",
    cpuName: "Ampere Altra Q80-30", cores: 2, mem: 2 * GiB, disk: 40 * GiB,
    price: 19.9, cycle: "quarterly", expiresIn: 66, trafficLimit: 400 * GiB, trafficMode: "sum",
    monthUsed: 0.12, rxBase: 1.1 * MiB, txBase: 1.8 * MiB,
    cpuBase: 9, cpuAmp: 5, memPct: 0.33, diskPct: 0.19,
    tcp: 41, udp: 6, procs: 88, uptime: 168 * 86400,
    // Two probes: the panel must fill the row rather than leave a hole.
    probes: [1, 2], online: true,
  },
  {
    id: 6, name: "法兰克福-01", country: "DE", group: "欧洲",
    os: "Debian 12", kernel: "6.1.0-28-cloud-amd64", arch: "x86_64", virt: "KVM",
    cpuName: "Intel Xeon Silver 4314", cores: 8, mem: 16 * GiB, disk: 320 * GiB,
    price: 129, currency: "EUR", cycle: "yearly", expiresIn: 298, trafficLimit: 8000 * GiB, trafficMode: "sum",
    monthUsed: 0.24, rxBase: 14.6 * MiB, txBase: 21.3 * MiB,
    cpuBase: 22, cpuAmp: 8, memPct: 0.41, diskPct: 0.35,
    tcp: 271, udp: 33, procs: 402, uptime: 231 * 86400,
    // Five probes: only the first three are drawn, per the design rule.
    probes: [1, 2, 3, 4, 5], online: true,
  },
  {
    id: 7, name: "上海-家宽", country: "CN", group: "国内",
    os: "Debian 12", kernel: "6.1.0-28-amd64", arch: "x86_64", virt: "物理机",
    cpuName: "Intel Core i5-12400", cores: 6, mem: 32 * GiB, disk: 1000 * GiB,
    price: 0, cycle: "once", expiresIn: null, trafficLimit: 100 * GiB, trafficMode: "up",
    monthUsed: 0.97, rxBase: 0.4 * MiB, txBase: 3.2 * MiB,
    cpuBase: 13, cpuAmp: 6, memPct: 0.38, diskPct: 0.58,
    tcp: 57, udp: 9, procs: 121, uptime: 19 * 86400,
    // One probe: a single column, not a row of empty cells.
    probes: [1], profiles: { 1: "flaky" }, online: true,
  },
  {
    id: 8, name: "广州-测试机", country: "CN", group: "",
    os: "Debian 11", kernel: "5.10.0-32-amd64", arch: "x86_64", virt: "KVM",
    cpuName: "Intel Xeon E5-2660 v3", cores: 1, mem: 1 * GiB, disk: 20 * GiB,
    price: 0, cycle: "once", expiresIn: null, trafficLimit: 0, trafficMode: "none",
    monthUsed: 0, rxBase: 0, txBase: 0,
    cpuBase: 0, cpuAmp: 0, memPct: 0, diskPct: 0.52,
    tcp: 0, udp: 0, procs: 0, uptime: 0, probes: [1, 2, 3], online: false,
  },
]

/** Uptime is measured from a boot fixed at load, so the figure ticks up. */
const BOOT: Record<number, number> = Object.fromEntries(
  SPECS.map((spec) => [spec.id, Date.now() - spec.uptime * 1000]),
)

/** A stable number in [0, 1) for a set of integer keys. */
function noise(...keys: number[]): number {
  let h = 0x811c9dc5
  for (const key of keys) {
    h = Math.imul(h ^ (key | 0), 0x01000193)
    h ^= h >>> 13
  }
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round2 = (v: number) => Math.round(v * 100) / 100

function monthStart(nowMs: number): string {
  const d = new Date(nowMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01T00:00:00Z`
}

function traffic(spec: Spec) {
  const used = Math.round(spec.trafficLimit * spec.monthUsed)
  // The direction the plan meters carries `monthUsed` itself, because that is
  // the figure the bar is drawn from. Splitting the month 78/22 whatever the
  // mode made an `up`-metered host its operator calls 97% read 21% -- the mock
  // would then hide exactly the case it was written to show.
  let month_rx: number
  let month_tx: number
  switch (spec.trafficMode) {
    case "up":
      month_tx = used
      month_rx = Math.round(used * 0.28)
      break
    case "down":
      month_rx = used
      month_tx = Math.round(used * 0.3)
      break
    case "max":
      // The larger of the two is the one that is metered, and it is the download.
      month_rx = used
      month_tx = Math.round(used * 0.55)
      break
    default:
      month_rx = Math.round(used * 0.78)
      month_tx = used - month_rx
  }
  return {
    month_rx,
    month_tx,
    total_rx: Math.round(month_rx * 3.4),
    total_tx: Math.round(month_tx * 4.1),
    day_rx: Math.round(month_rx / 27 * (0.7 + 0.6 * noise(spec.id, 11))),
    day_tx: Math.round(month_tx / 27 * (0.7 + 0.6 * noise(spec.id, 12))),
  }
}

function liveMetrics(spec: Spec, nowMs: number) {
  const m = Math.floor(nowMs / 60_000)
  const t = Math.floor(nowMs / 10_000)
  // Two waves per figure: a slow one that makes a card read differently from
  // its neighbour, and a fast one that keeps the numbers moving between polls.
  const wave = (period: number, phase: number) => Math.sin(m / period + spec.id * 1.7 + phase)
  const jitter = (key: number, spread: number) => spread * (noise(spec.id, m, key) - 0.5)

  const cpu = round2(clamp(spec.cpuBase + spec.cpuAmp * (0.65 * wave(19, 0.3) + 0.35 * wave(3.7, 1.9)) + jitter(1, 8), 0.3, 100))
  const cores = spec.cores
  const load: [number, number, number] = [
    round2((cpu / 100) * cores * 1.15),
    round2((cpu / 100) * cores * (0.82 + 0.06 * wave(7, 2))),
    round2((cpu / 100) * cores * (0.61 + 0.09 * wave(31, 4))),
  ]
  const mem_used = Math.round(clamp(spec.mem * (spec.memPct + 0.03 * wave(140, 0.8) + jitter(2, 0.012)), 0, spec.mem))
  const swap_total = spec.id === 5 ? 0 : Math.round(spec.mem / 4)
  const net = (base: number, key: number) =>
    Math.round(base * clamp(0.55 + 0.8 * Math.abs(wave(7, key * 1.3)) + 0.3 * (noise(spec.id, t, key) - 0.5), 0.02, 3))

  return {
    uptime: Math.max(0, Math.floor((nowMs - (BOOT[spec.id] ?? nowMs)) / 1000)),
    cpu,
    load,
    mem_total: spec.mem,
    mem_used,
    swap_total,
    swap_used: swap_total === 0 ? 0 : Math.round(swap_total * 0.06 * (1 + noise(spec.id, m, 3))),
    disk_total: spec.disk,
    disk_used: Math.round(spec.disk * spec.diskPct),
    net_rx: net(spec.rxBase, 4),
    net_tx: net(spec.txBase, 5),
    ...traffic(spec),
    tcp: Math.round(spec.tcp * (0.8 + 0.4 * noise(spec.id, m, 6))),
    udp: Math.round(spec.udp * (0.7 + 0.6 * noise(spec.id, m, 7))),
    procs: Math.round(spec.procs * (0.94 + 0.12 * noise(spec.id, m, 8))),
  }
}

/** The live fleet, in the shape `/api/nodes` and every pushed frame carry. */
export function nodeList(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000)
  return SPECS.map((spec, i) => {
    const metrics = spec.online ? liveMetrics(spec, nowMs) : null
    const { total_rx, total_tx, month_rx, month_tx, day_rx, day_tx } = traffic(spec)
    return {
      id: spec.id,
      name: spec.name,
      sort: i,
      public: true,
      online: spec.online,
      country: spec.country,
      group: spec.group,
      last_seen: spec.online ? now : now - 3 * 3600,
      last_seen_ago: spec.online ? 0 : 3 * 3600,
      metrics,
      os: spec.os,
      kernel: spec.kernel,
      arch: spec.arch,
      virt: spec.virt,
      cpu_name: spec.cpuName,
      cpu_cores: spec.cores,
      mem_total: spec.mem,
      swap_total: metrics?.swap_total ?? 0,
      disk_total: spec.disk,
      agent_version: "1.4.2",
      price: spec.price,
      currency: spec.currency ?? "CNY",
      billing_cycle: spec.cycle,
      expires_at: spec.expiresIn === null ? null : new Date(nowMs + spec.expiresIn * 86_400_000).toISOString(),
      expires_in: spec.expiresIn,
      traffic_limit: spec.trafficLimit,
      traffic_mode: spec.trafficMode,
      traffic_reset_day: 1,
      total_rx, total_tx, month_rx, month_tx,
      // The plan's own counting rule, the same switch the hub and the panel use.
      // Summing both directions regardless reported 97% of a quota a `up`-metered
      // plan would call 3%, and the mock is the only place this theme is read.
      month_used: planUsage(spec, month_rx, month_tx),
      month_start: monthStart(nowMs),
      day_rx, day_tx,
      public_remark: spec.publicRemark ?? "",
      hostname: spec.name.toLowerCase(),
    }
  })
}

/** What a plan meters: one direction, the larger of the two, or both. */
function planUsage(spec: Spec, rx: number, tx: number): number {
  switch (spec.trafficMode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

/** The window a request is answered with, matching `api::span`. */
function spanOf(hours: number, points: number, nowMs: number) {
  const step = Math.max(60, Math.ceil((hours * 3600) / points / 60) * 60)
  const now = Math.floor(nowMs / 1000)
  const newest = Math.floor(now / step) * step
  return { step, newest, since: newest - (points - 1) * step }
}

/** The round-trip a healthy line to `country` takes from Shanghai, in ms. */
const ROUTE_MS: Record<string, number> = { HK: 34, JP: 79, SG: 66, US: 172, DE: 214, CN: 11 }

type Sample = { latency: number | null; lost: boolean }

/**
 * One probe's minute: either an answer or a lost packet, never both. Losses are
 * whole samples rather than a fraction of one, because that is what a probe can
 * observe -- `ping_records` divides a bucket's lost count by the samples taken.
 */
function pingSample(spec: Spec, task: number, minute: number): Sample {
  const base = ROUTE_MS[spec.country] * (task === 3 ? 1.32 : task === 4 ? 1.12 : task === 5 ? 1.08 : 1)
  const profile = spec.profiles?.[task] ?? "good"
  // Each bad profile runs a cycle shorter than the hour the panel draws, so a
  // bad stretch is always on screen somewhere -- a cycle longer than the window
  // can sit entirely in the part of it that has scrolled past, and the card
  // meant to demonstrate a broken line would show nothing at all.
  const offset = Math.round(noise(spec.id, task) * 40)
  let scale = 1
  let lossRate = 0.0015
  switch (profile) {
    case "congested": {
      const phase = (minute + offset) % 44
      if (phase < 9) {
        // Congestion proper: the queue is full, so most probes time out and the
        // ones that answer are several times slower.
        scale = 3.4
        lossRate = 0.42
      } else if (phase < 16) {
        scale = 1.9
        lossRate = 0.09
      } else {
        scale = 1.08
        lossRate = 0.004
      }
      break
    }
    case "lossy": {
      const phase = (minute + offset) % 38
      if (phase < 6) {
        scale = 1.25
        lossRate = 0.32
      } else if (phase < 9) {
        lossRate = 0.12
      } else {
        scale = 1.05
        lossRate = 0.005
      }
      break
    }
    case "flaky": {
      const phase = (minute + offset) % 55
      if (phase < 14) return { latency: null, lost: true }
      scale = 1.05
      lossRate = 0.01
      break
    }
  }
  if (noise(spec.id, task, minute, 9) < lossRate) return { latency: null, lost: true }
  const jitter = 1 + 0.09 * (noise(spec.id, task, minute, 4) - 0.5) + 0.06 * Math.sin(minute / 17 + spec.id)
  return { latency: Math.max(1, Math.round(base * scale * jitter)), lost: false }
}

function quantile(sorted: number[]): number | null {
  if (sorted.length === 0) return null
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** The probe names assigned to a node, keyed as the hub keys them, in id order. */
export function probeNames(spec: Spec): Record<string, string> {
  return Object.fromEntries(PROBES.filter((p) => spec.probes.includes(p.id)).map((p) => [String(p.id), p.name]))
}

export type Window = {
  metrics: Record<string, number>[]
  ping: Record<string, number | number[] | null>[]
  probes: Record<string, string>
  loss: Record<string, number>
  step: number
}

/** Rows for one series half of `/api/nodes/{id}/metrics`, as `db.rs` builds them. */
export function history(id: number, series: "metrics" | "ping", hours: number, points: number, nowMs = Date.now()): Window {
  const spec = SPECS.find((s) => s.id === id)
  const { step, newest, since } = spanOf(hours, points, nowMs)
  const empty: Window = { metrics: [], ping: [], probes: {}, loss: {}, step }
  if (!spec || !spec.online) return empty

  const buckets = Math.max(1, Math.round((newest - since) / step) + 1)
  if (series === "metrics") {
    const rows = Array.from({ length: buckets }, (_, i) => {
      const ts = since + i * step
      const m = liveMetrics(spec, ts * 1000)
      return {
        ts,
        cpu: m.cpu,
        mem_used: m.mem_used,
        disk_used: m.disk_used,
        net_rx: m.net_rx,
        net_tx: m.net_tx,
        net_rx_max: Math.round(m.net_rx * 1.9),
        net_tx_max: Math.round(m.net_tx * 1.9),
        cpu_max: Math.min(100, round2(m.cpu * 1.6)),
        minutes: Math.min(step / 60, 60),
        swap_used: m.swap_used,
        tcp: m.tcp,
        udp: m.udp,
        procs: m.procs,
      }
    })
    return { ...empty, metrics: rows }
  }

  const probes = probeNames(spec)
  const ping: Window["ping"] = []
  const lost = new Map<string, number>()
  const taken = new Map<string, number>()

  for (const task of spec.probes) {
    const key = String(task)
    for (let i = 0; i < buckets; i++) {
      const ts = since + i * step
      const answers: number[] = []
      let loss = 0
      let total = 0
      for (let minute = 0; minute < step / 60; minute++) {
        const at = Math.floor((ts + minute * 60) / 60)
        // The bucket still filling only holds the minutes that have passed.
        if (ts + (minute + 1) * 60 > Math.floor(nowMs / 1000)) break
        const sample = pingSample(spec, task, at)
        total++
        if (sample.lost) loss++
        else if (sample.latency !== null) answers.push(sample.latency)
      }
      if (total === 0) continue
      answers.sort((a, b) => a - b)
      const row: Record<string, number | number[] | null> = { task_id: task, ts, latency: quantile(answers) }
      if (answers.length > 1 && answers[answers.length - 1] > answers[0]) {
        row.band = [answers[0], answers[answers.length - 1]]
      }
      if (loss > 0) row.loss = Math.ceil((100 * loss) / total)
      ping.push(row)
      lost.set(key, (lost.get(key) ?? 0) + loss)
      taken.set(key, (taken.get(key) ?? 0) + total)
    }
  }

  // Window-level loss, unrounded, as `ping_records` returns it: the buckets'
  // percentages cannot be averaged back into it.
  const loss: Record<string, number> = {}
  for (const [key, count] of lost) {
    if (count === 0) continue
    loss[key] = Math.round((10_000 * count) / (taken.get(key) ?? 1)) / 100
  }
  return { ...empty, ping, probes, loss }
}
