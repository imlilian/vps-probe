import {
  Activity, ArrowUpDown, Banknote, CalendarClock, ChevronDown, ChevronUp, Clock, Coins, Cpu,
  Gauge, HardDrive, ListOrdered, MemoryStick, Plug, Receipt, Repeat,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { priceParts } from "@/components/Billing"
import type { Node } from "@/lib/api"
import {
  detailBytes, detailRate, monthlyCost, remainingTime, remainingValue, trafficPct, trafficUsed, uptimeLong,
} from "@/lib/detail"
import { cycle, money, percent, splitUnit } from "@/lib/format"

import { MetricTile, type MetricTone } from "./MetricTile"

type Item = {
  key: string
  label: string
  value: string
  unit?: string
  icon: LucideIcon
  title?: string
  tone?: MetricTone
  valueClass?: string
}

const pct = (value: number) => value.toFixed(1)

/**
 * The sixteen figures the page opens with. They are all live: the node prop
 * arrives over the stream and re-renders this grid every two seconds, while the
 * charts below keep drawing their history.
 *
 * The order is the order someone scans a machine: what it costs, what is
 * filling up, what is queued, and how much it has moved. It is fixed here
 * rather than configurable -- a public status page has one reader, not an
 * editor.
 */
export function MetricGrid({ node }: { node: Node }) {
  const m = node.metrics
  const price = priceParts(node)
  const priceValue = price.mark ? `${price.mark}${price.value}` : price.value
  const monthly = monthlyCost(node)
  const left = remainingTime(node)
  const worth = remainingValue(node)
  const quota = trafficPct(node)
  const used = trafficUsed(node)
  const totalTraffic = detailBytes(node.total_rx + node.total_tx)
  const [totalValue, totalUnit] = splitUnit(totalTraffic)
  const up = splitUnit(detailBytes(m?.net_tx ?? 0))
  const down = splitUnit(detailBytes(m?.net_rx ?? 0))

  const items: Item[] = [
    {
      key: "price",
      label: "节点价格",
      value: priceValue,
      unit: price.suffix ? `/ ${price.suffix}` : undefined,
      icon: Banknote,
      title: cycle(node.billing_cycle),
    },
    {
      key: "monthly",
      label: "月均支出",
      value: monthly === null ? "不适用" : monthly === 0 ? "免费" : money(monthly, node.currency),
      unit: monthly === null || monthly === 0 ? undefined : "/ 月",
      icon: Receipt,
      title: "价格 ÷ 计费周期",
    },
    {
      key: "remaining",
      label: "剩余时间",
      value: left.value,
      unit: left.unit,
      icon: CalendarClock,
      tone: left.tone,
      title: node.expires_at ? `到期 ${node.expires_at.slice(0, 10)}` : "不限期",
    },
    {
      key: "value",
      label: "剩余价值",
      value: node.price <= 0 ? "无" : worth === null ? "—" : money(worth, node.currency),
      icon: Coins,
      title: "按本币估算，未做汇率换算",
    },
    {
      key: "cpu",
      label: "CPU 使用率",
      value: m ? pct(m.cpu) : "—",
      unit: m ? "%" : undefined,
      icon: Cpu,
      title: m ? `${node.cpu_cores} 核 · 负载 ${m.load[0].toFixed(2)}` : undefined,
    },
    {
      key: "mem",
      label: "内存使用率",
      value: m ? pct(percent(m.mem_used, m.mem_total)) : "—",
      unit: m ? "%" : undefined,
      icon: MemoryStick,
      title: m ? `${detailBytes(m.mem_used)} / ${detailBytes(m.mem_total)}` : undefined,
    },
    {
      key: "swap",
      label: "交换内存",
      value: m && m.swap_total > 0 ? pct(percent(m.swap_used, m.swap_total)) : "—",
      unit: m && m.swap_total > 0 ? "%" : undefined,
      icon: Repeat,
      title: m && m.swap_total > 0 ? `${detailBytes(m.swap_used)} / ${detailBytes(m.swap_total)}` : "没有 Swap",
    },
    {
      key: "disk",
      label: "硬盘使用率",
      value: m ? pct(percent(m.disk_used, m.disk_total)) : "—",
      unit: m ? "%" : undefined,
      icon: HardDrive,
      title: m ? `${detailBytes(m.disk_used)} / ${detailBytes(m.disk_total)}` : undefined,
    },
    {
      key: "load",
      label: "系统负载",
      value: m ? m.load[0].toFixed(2) : "—",
      unit: m ? "1m" : undefined,
      icon: Activity,
      title: m ? `5m ${m.load[1].toFixed(2)} / 15m ${m.load[2].toFixed(2)}` : undefined,
    },
    {
      key: "procs",
      label: "进程数",
      value: m ? m.procs.toLocaleString("zh-CN") : "—",
      icon: ListOrdered,
    },
    {
      key: "conns",
      label: "连接数",
      value: m ? (m.tcp + m.udp).toLocaleString("zh-CN") : "—",
      icon: Plug,
      title: m ? `TCP ${m.tcp} / UDP ${m.udp}` : undefined,
    },
    {
      key: "uptime",
      label: "运行时间",
      value: m ? uptimeLong(m.uptime) : "—",
      icon: Clock,
      valueClass: "text-sm leading-tight sm:text-2xl",
      title: m ? uptimeLong(m.uptime) : undefined,
    },
    {
      key: "up",
      label: "实时上行",
      value: m ? up[0] : "—",
      unit: m ? `${up[1]}/s` : undefined,
      icon: ChevronUp,
      title: m ? detailRate(m.net_tx) : undefined,
    },
    {
      key: "down",
      label: "实时下行",
      value: m ? down[0] : "—",
      unit: m ? `${down[1]}/s` : undefined,
      icon: ChevronDown,
      title: m ? detailRate(m.net_rx) : undefined,
    },
    {
      key: "total",
      label: "累计流量",
      value: totalValue,
      unit: totalUnit,
      icon: ArrowUpDown,
      title: `↑ ${detailBytes(node.total_tx)} / ↓ ${detailBytes(node.total_rx)}`,
    },
    {
      key: "quota",
      label: "流量配额",
      value: quota === null ? "∞" : pct(quota),
      unit: quota === null ? undefined : "%",
      icon: Gauge,
      title: quota === null ? "无限流量" : `${detailBytes(used)} / ${detailBytes(node.traffic_limit)}`,
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {items.map(({ key, ...item }) => <MetricTile key={key} {...item} />)}
    </div>
  )
}
