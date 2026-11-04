/**
 * The list's ordering, apart from the control that picks it: ten questions a
 * visitor can ask of a fleet, and one function that answers them.
 *
 * Nothing here touches the DOM or `localStorage`, so the order a page shows can
 * be asserted under plain node. The order is not kept in the address bar: nobody
 * shares a link to "my nodes by CPU", and a query string would make every press
 * of a chip a history entry.
 */
import type { Node } from "./api.ts"
import { percent } from "./format.ts"
import { toUSD } from "./rates.ts"
import { daysLeft } from "./stats.ts"

export type Dir = "asc" | "desc"
export type SortKey =
  | "operator" | "name" | "country" | "cpu" | "mem" | "disk"
  | "rate" | "today" | "uptime" | "price" | "expiry"

export type Order = { key: SortKey; dir: Dir }

/** A key's reading for one node; null where the node has no such figure. */
type Value = string | number | null

export type Sort = {
  key: SortKey
  /** What the picker shows: two characters where the language allows it. */
  label: string
  /** What it means, in a tooltip and for a screen reader. */
  hint: string
  /** The direction the key opens in: the one a reader would ask for first. */
  dir: Dir
  of: (node: Node) => Value
}

/**
 * Regions named in Chinese, so that sorting by 地区 groups a fleet the way a
 * reader expects -- 德国, 美国, 日本, 香港 -- instead of by ISO letters, where D
 * and J and U carry no meaning at all.
 *
 * A curated table rather than `Intl.DisplayNames`, which is a table too but one
 * this build cannot inspect: it renders HK as 中国香港特别行政区 and TW as its
 * short form, and a label that may one day reach the page is worth owning. Codes
 * outside the list -- the hub geolocates what it can -- fall back to their own
 * letters, and cluster together either way.
 */
const REGIONS: Record<string, string> = {
  CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾",
  JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚", TH: "泰国", VN: "越南",
  ID: "印度尼西亚", PH: "菲律宾", IN: "印度", PK: "巴基斯坦", BD: "孟加拉国",
  AE: "阿联酋", IL: "以色列", SA: "沙特", TR: "土耳其", KZ: "哈萨克斯坦",
  US: "美国", CA: "加拿大", MX: "墨西哥", BR: "巴西", AR: "阿根廷", CL: "智利",
  GB: "英国", IE: "爱尔兰", DE: "德国", FR: "法国", NL: "荷兰", BE: "比利时",
  LU: "卢森堡", CH: "瑞士", AT: "奥地利", IT: "意大利", ES: "西班牙", PT: "葡萄牙",
  SE: "瑞典", NO: "挪威", DK: "丹麦", FI: "芬兰", IS: "冰岛", PL: "波兰",
  CZ: "捷克", SK: "斯洛伐克", HU: "匈牙利", RO: "罗马尼亚", BG: "保加利亚",
  GR: "希腊", UA: "乌克兰", RU: "俄罗斯", LT: "立陶宛", LV: "拉脱维亚", EE: "爱沙尼亚",
  AU: "澳大利亚", NZ: "新西兰", ZA: "南非", NG: "尼日利亚", EG: "埃及",
}

/**
 * The figure keys are the live ones, so an offline node has no reading and falls
 * to the end of the list -- which is where a machine with no numbers belongs,
 * rather than at 0% as if it were idle. The keys that do not need a report
 * (name, region, today's counters, price, expiry) rank an offline node like any
 * other: a plan running out tomorrow is urgent whether or not the box answers.
 */
function live(node: Node) {
  return node.online ? node.metrics : null
}

export const SORTS: Sort[] = [
  {
    key: "operator",
    label: "默认",
    hint: "站点里排的顺序",
    dir: "asc",
    of: (node) => node.sort,
  },
  {
    key: "name",
    label: "名称",
    hint: "按名称，按中文读音",
    dir: "asc",
    of: (node) => node.name || null,
  },
  {
    key: "country",
    label: "地区",
    hint: "按地区，同一地区的机器排在一起",
    dir: "asc",
    of: (node) => (node.country ? (REGIONS[node.country] ?? node.country) : null),
  },
  {
    key: "cpu",
    label: "CPU",
    hint: "按 CPU 使用率",
    dir: "desc",
    of: (node) => live(node)?.cpu ?? null,
  },
  {
    key: "mem",
    label: "内存",
    hint: "按内存使用率",
    dir: "desc",
    of: (node) => {
      const m = live(node)
      return m ? percent(m.mem_used, m.mem_total) : null
    },
  },
  {
    key: "disk",
    label: "硬盘",
    hint: "按硬盘使用率",
    dir: "desc",
    of: (node) => {
      const m = live(node)
      return m ? percent(m.disk_used, m.disk_total) : null
    },
  },
  {
    key: "rate",
    label: "速率",
    hint: "按此刻的速率，上下行合计",
    dir: "desc",
    of: (node) => {
      const m = live(node)
      return m ? m.net_rx + m.net_tx : null
    },
  },
  {
    key: "today",
    label: "流量",
    hint: "按今日流量，上下行合计；离线的机器也留着这个数",
    dir: "desc",
    of: (node) => node.day_rx + node.day_tx,
  },
  {
    key: "uptime",
    label: "在线",
    hint: "按连续在线时长",
    dir: "desc",
    of: (node) => live(node)?.uptime ?? null,
  },
  {
    key: "price",
    label: "价格",
    hint: "按价格，折成美元比较；没有价格的排在最后",
    dir: "desc",
    of: (node) => (node.price > 0 ? toUSD(node.price, node.currency) : null),
  },
  {
    key: "expiry",
    label: "到期",
    hint: "按到期时间，最急的在前；永不到期的排在最后",
    dir: "asc",
    of: (node) => daysLeft(node),
  },
]

export function sortFor(key: SortKey): Sort {
  return SORTS.find((s) => s.key === key) ?? SORTS[0]!
}

/** The keyboard's own order, and the one a hub's operator arranged. */
const byOperator = (a: Node, b: Node) => a.sort - b.sort || a.id - b.id

/**
 * `numeric` so that CN2-2 precedes CN2-10, and a Chinese collator so that
 * 东京 sorts by its reading rather than by its code point -- the order a reader
 * of this page already has in their head.
 */
const collator = new Intl.Collator("zh-CN", { numeric: true })

function compare(a: Value, b: Value) {
  if (typeof a === "number" && typeof b === "number") return a - b
  return collator.compare(String(a), String(b))
}

/**
 * The list in the order asked for.
 *
 * Missing readings go last whichever way the arrow points -- reversing a sort
 * should not bring the nodes with no figure to the top, where they would read as
 * the answer. Everything else is ordered by the key and, on a tie, by the
 * operator's own order, so two nodes at 34% do not swap places between frames.
 */
export function arrange(nodes: Node[], order: Order): Node[] {
  const sort = sortFor(order.key)
  const sign = order.dir === "asc" ? 1 : -1
  const ranked: { node: Node; value: Value }[] = []
  const absent: Node[] = []

  for (const node of nodes) {
    const value = sort.of(node)
    if (value === null) absent.push(node)
    else ranked.push({ node, value })
  }

  ranked.sort((a, b) => sign * compare(a.value, b.value) || byOperator(a.node, b.node))
  absent.sort(byOperator)
  return [...ranked.map((r) => r.node), ...absent]
}

/**
 * Pressing a key that is already sorting turns it around; picking a different
 * one opens it in the direction that key was meant for, rather than carrying a
 * `desc` from the last one onto 名称.
 */
export function nextOrder(order: Order, key: SortKey): Order {
  if (key !== order.key) return { key, dir: sortFor(key).dir }
  return { key, dir: order.dir === "asc" ? "desc" : "asc" }
}

export const DEFAULT_ORDER: Order = { key: "operator", dir: "asc" }

/** A stored order or anything at all, made safe: `localStorage` is user input. */
export function parseOrder(raw: string | null): Order {
  const [key, dir] = (raw ?? "").split(":")
  if (!SORTS.some((s) => s.key === key)) return DEFAULT_ORDER
  return { key: key as SortKey, dir: dir === "asc" || dir === "desc" ? dir : sortFor(key as SortKey).dir }
}

export function formatOrder(order: Order): string {
  return `${order.key}:${order.dir}`
}

export type Density = "standard" | "compact"
