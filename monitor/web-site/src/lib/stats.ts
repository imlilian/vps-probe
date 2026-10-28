/**
 * The overview's arithmetic, apart from the component that draws it: every figure
 * on that row is a fold over the same pushed list, and a fold is worth being able
 * to call from a test without a browser.
 *
 * Everything here follows the hub's own definitions rather than recomputing them:
 * `day_rx`/`day_tx` are the hub's daily counters, `expires_in` is its calendar,
 * `month_used` its metering rule. The only thing invented here is the remaining
 * value, which no hub field carries.
 */
import type { Node } from "./api.ts"
import { cycleMonths, daysUntil } from "./format.ts"
import { toUSD } from "./rates.ts"

/**
 * This period's usage as the plan meters it. The hub computes it; the switch
 * below serves only a hub from before `month_used`. Lives here rather than in
 * the node card because the detail page's quota card asks the same question and
 * must get the same answer.
 */
export function monthUsage(node: Node): number {
  if (typeof node.month_used === "number") return node.month_used
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
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

/**
 * Days left on a plan, on the hub's calendar when it sends one.
 *
 * Exported because the list's expiry sort asks the same question of the same
 * field, and the answer has to be identical: hub days where the hub sent them,
 * the browser's count only for a hub from before `expires_in`.
 */
export function daysLeft(node: Node): number | null {
  return node.expires_in !== undefined ? node.expires_in : daysUntil(node.expires_at)
}

export function fleet(nodes: Node[]) {
  const online = nodes.filter((n) => n.online).length
  return { total: nodes.length, online, offline: nodes.length - online }
}

/**
 * The busiest node rather than the fleet average: one machine pinned at 95% is
 * the thing to look at, and a row of idle ones would average it into nothing.
 */
export function busiest(nodes: Node[]): { node: Node; cpu: number } | null {
  let top: { node: Node; cpu: number } | null = null
  for (const node of nodes) {
    if (!node.online || !node.metrics) continue
    if (!top || node.metrics.cpu > top.cpu) top = { node, cpu: node.metrics.cpu }
  }
  return top
}

export type Flow = { rx: number; tx: number }

/** Today's counters, summed over every node -- offline machines keep them. */
export function today(nodes: Node[]): Flow {
  return nodes.reduce((sum, n) => ({ rx: sum.rx + n.day_rx, tx: sum.tx + n.day_tx }), { rx: 0, tx: 0 })
}

/** This instant's throughput. A node that is not reporting contributes nothing. */
export function live(nodes: Node[]): Flow {
  return nodes.reduce(
    (sum, n) => (n.online && n.metrics ? { rx: sum.rx + n.metrics.net_rx, tx: sum.tx + n.metrics.net_tx } : sum),
    { rx: 0, tx: 0 },
  )
}

export type Due = { soon: number; expired: number }

/**
 * Plans inside `within` days of ending. Expiry is counted apart from it, because
 * one is a bill to schedule and the other is a machine about to go dark.
 */
export function due(nodes: Node[], within = 30): Due {
  let soon = 0
  let expired = 0
  for (const node of nodes) {
    const days = daysLeft(node)
    if (days === null) continue
    if (days < 0) expired++
    else if (days <= within) soon++
  }
  return { soon, expired }
}

export type Residual = {
  /** What the running plans are still worth, in US dollars. */
  usd: number
  /** Nodes this figure is made of. */
  counted: number
  /** Nodes left out: no price, no expiry, a one-off purchase, or no rate. */
  left: number
}

/**
 * What is left of the prepaid time, at `price x days left / days paid for`. No
 * hub field carries this, so it is an estimate and the card says nothing more
 * precise than a figure. A month is 30 days, which is the resolution of a plan
 * priced per month; a node already past its date is worth nothing rather than a
 * negative amount. One-off purchases have no period to prorate, so they are left
 * out along with anything unpriced.
 *
 * Every currency is converted to dollars before it is added: the alternative --
 * summing by currency and showing the largest group -- answered "what is left in
 * the currency most of my machines happen to be billed in", which is not the
 * question the card asks. A currency the rate table does not know is left out
 * and counted rather than converted at a guess.
 */
export function residual(nodes: Node[]): Residual | null {
  let usd = 0
  let counted = 0
  let left = 0
  for (const node of nodes) {
    const days = daysLeft(node)
    const months = cycleMonths(node.billing_cycle)
    const worth =
      days === null || months === null || !(node.price > 0)
        ? null
        : toUSD((node.price * Math.max(0, days)) / (months * 30), node.currency)
    if (worth === null) {
      left++
      continue
    }
    usd += worth
    counted++
  }
  if (!counted) return null
  // Rounded once, at the end: the tail of a converted sum is float noise, and
  // what is drawn is a whole dollar anyway.
  return { usd: Math.round(usd * 100) / 100, counted, left }
}
