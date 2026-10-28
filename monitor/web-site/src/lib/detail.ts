import type { Node } from "./api.ts"
import { bytes, cycleMonths, daysUntil } from "./format.ts"
import { monthUsage } from "./stats.ts"

/** How a remaining-time figure is coloured; the component owns the classes. */
export type Tone = "ok" | "warn" | "danger" | "muted"

/** Whole days left, on the hub's calendar when it sent one. */
export function expiryDays(node: Node): number | null {
  if (node.expires_in !== undefined) return node.expires_in
  return daysUntil(node.expires_at?.slice(0, 10))
}

export function expiryTone(days: number | null): Tone {
  if (days === null) return "muted"
  if (days < 0 || days <= 5) return "danger"
  if (days <= 10) return "warn"
  if (days > 36_500) return "muted"
  return "ok"
}

export type RemainingTime = { value: string; unit?: string; tone: Tone }

/**
 * The distance to the renewal as a figure and the unit it is counted in.
 * `今天到期` / `长期` / `已过期` are words rather than a number with a unit,
 * because a unit under them would be a unit under no number.
 */
export function remainingTime(node: Node): RemainingTime {
  const days = expiryDays(node)
  if (days === null) return { value: "永久", tone: "muted" }
  if (days < 0) return { value: `已过期 ${-days}`, unit: "天", tone: "danger" }
  if (days === 0) return { value: "今天", unit: "到期", tone: "warn" }
  if (days > 36_500) return { value: "长期", tone: "muted" }
  return { value: String(days), unit: "天", tone: expiryTone(days) }
}

/**
 * What the plan costs per month: the price spread over the months it buys.
 * A one-off purchase has no monthly figure, and a free machine is zero rather
 * than "unknown" so the card can say 免费.
 */
export function monthlyCost(node: Node): number | null {
  if (!(node.price > 0)) return 0
  const months = cycleMonths(node.billing_cycle)
  if (months === null) return null
  return node.price / months
}

/**
 * The unused part of the current period, prorated over the days it covers.
 * Kept in the node's own currency: the page has no live exchange rate, and a
 * static one would make the figure look more precise than it is.
 */
export function remainingValue(node: Node): number | null {
  if (!(node.price > 0)) return null
  const days = expiryDays(node)
  if (days === null) return null
  if (days <= 0) return 0
  const months = cycleMonths(node.billing_cycle)
  if (months === null) return node.price
  if (days > 36_500) return node.price
  return (node.price * Math.min(days, months * 30)) / (months * 30)
}

/** This period's usage as the plan meters it; the hub's own figure where present. */
export function trafficUsed(node: Node): number {
  return monthUsage(node)
}

/** Percent of the period's allowance, capped at 100; null when there is no cap. */
export function trafficPct(node: Node): number | null {
  if (!(node.traffic_limit > 0)) return null
  return Math.min(100, (trafficUsed(node) / node.traffic_limit) * 100)
}

/** `30 天 10 小时 38 分钟`, with a sentence for the first minute. */
export function uptimeLong(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 秒"
  if (seconds < 60) return "不足 1 分钟"
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时 ${m} 分钟` : h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}

/**
 * Detail-page byte formatting: the reference figure's fixed decimals, rather
 * than the list's three significant digits. B/KB whole, MB/GB one decimal,
 * TB two. The list keeps `bytes()`; this is the page's own reading.
 */
export function detailBytes(n: number): string {
  if (!n || n < 1) return "0 B"
  const digits = n >= 1024 ** 4 ? 2 : n >= 1024 ** 2 ? 1 : 0
  return bytes(n, digits)
}

export function detailRate(n: number): string {
  return `${detailBytes(n)}/s`
}

/** A 24-hour metrics row, as much as the peak calculation reads. */
export type PeakRow = {
  net_rx?: number
  net_tx?: number
  net_rx_max?: number
  net_tx_max?: number
}

/**
 * The highest rate in a day, each way. The hub's bucket maxima are preferred;
 * a hub from before them falls back to the bucket means. Both zero is "no
 * data", not a peak of zero.
 */
export function peakOf(rows: PeakRow[]): { rx: number; tx: number } | null {
  let rx = 0
  let tx = 0
  for (const row of rows) {
    rx = Math.max(rx, row.net_rx_max ?? row.net_rx ?? 0)
    tx = Math.max(tx, row.net_tx_max ?? row.net_tx ?? 0)
  }
  return rx > 0 || tx > 0 ? { rx, tx } : null
}

/**
 * A linear projection of the disk filling, for the disk card's subtitle. It is
 * deliberately quiet: a flat or falling disk has no forecast, and a projection
 * past ten years is not a fact worth printing. The rows are the window the
 * chart is already showing; no extra request is made.
 */
export function diskForecast(rows: { ts: number; disk_used?: number }[], total: number): string | null {
  if (!(total > 0)) return null
  const points = rows.filter((row): row is { ts: number; disk_used: number } => typeof row.disk_used === "number")
  if (points.length < 2) return null
  const first = points[0]
  const last = points[points.length - 1]
  const days = (last.ts - first.ts) / 86_400_000
  if (!(days > 0)) return null
  const slope = (last.disk_used - first.disk_used) / days
  if (!(slope > 0)) return null
  const remaining = total - last.disk_used
  if (remaining <= 0) return "预计已满"
  const left = remaining / slope
  if (!Number.isFinite(left) || left > 3_650) return null
  return `预计 ${Math.ceil(left)} 天后满`
}
