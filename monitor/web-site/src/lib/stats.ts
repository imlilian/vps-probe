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

/** Days left on a plan, on the hub's calendar when it sends one. */
function daysLeft(node: Node): number | null {
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
  /** What the running plans are still worth, in `currency`. */
  amount: number
  currency: string
  /** Nodes this figure is made of. */
  counted: number
  /** Nodes left out: no price, no expiry, or a currency other than `currency`. */
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
 * Currencies are not added together: the largest group decides, and the rest are
 * reported as `left` so the figure does not silently mix yuan and dollars.
 */
export function residual(nodes: Node[]): Residual | null {
  const buckets = new Map<string, { amount: number; nodes: number }>()
  let left = 0
  for (const node of nodes) {
    const days = daysLeft(node)
    const months = cycleMonths(node.billing_cycle)
    if (days === null || months === null || !(node.price > 0)) {
      left++
      continue
    }
    const worth = (node.price * Math.max(0, days)) / (months * 30)
    const bucket = buckets.get(node.currency) ?? { amount: 0, nodes: 0 }
    bucket.amount += worth
    bucket.nodes++
    buckets.set(node.currency, bucket)
  }
  // Most nodes, not most money: what the fleet is mostly billed in is the
  // currency the visitor thinks in, even where one host costs more than ten.
  const ranked = [...buckets].sort((a, b) => b[1].nodes - a[1].nodes)
  const main = ranked[0]
  if (!main) return null
  const others = ranked.slice(1).reduce((count, [, bucket]) => count + bucket.nodes, 0)
  return { amount: main[1].amount, currency: main[0], counted: main[1].nodes, left: left + others }
}
