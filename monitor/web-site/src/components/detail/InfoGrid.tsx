import {
  ArrowUpDown, Building2, Clock, Cpu, ExternalLink, Gauge, HardDrive, Layers, MemoryStick,
  Monitor, Repeat, Server, Terminal,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Card } from "@/components/ui/card"
import { Glyph } from "@/components/ui/glyph"
import { OsMark } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { cpuRating, passMarkUrl } from "@/lib/cpu"
import { detailBytes, detailRate, trafficPct, trafficUsed, uptimeLong } from "@/lib/detail"
import { useDayPeak } from "@/lib/history"
import { cpuName, osName } from "@/lib/format"
import { cn } from "@/lib/utils"

function InfoCard({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("min-w-0 gap-0 p-4", className)}>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-3 min-w-0 flex-1">{children}</div>
    </Card>
  )
}

function InfoCell({ icon: Icon, label, value, className }: {
  icon: LucideIcon
  label: string
  value: ReactNode
  className?: string
}) {
  return (
    <div className={cn("min-w-0 rounded-lg bg-card-2 p-2.5", className)}>
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Glyph icon={Icon} box="sm" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-xs leading-snug break-words sm:text-sm">{value}</div>
    </div>
  )
}

/** The tier's colour, in the token the rest of the page uses for that meaning. */
const TIER_TONE = {
  S: { text: "text-warn", bar: "bg-warn" },
  A: { text: "text-brand", bar: "bg-brand" },
  B: { text: "text-ok", bar: "bg-ok" },
  C: { text: "text-warn", bar: "bg-warn" },
  D: { text: "text-destructive", bar: "bg-destructive" },
  "?": { text: "text-muted-foreground", bar: "bg-muted-foreground" },
} as const

function HardwareCard({ node }: { node: Node }) {
  const rating = cpuRating(node.cpu_name)
  const tone = TIER_TONE[rating.tier]
  const model = cpuName(node.cpu_name) || "未知 CPU"
  const small = [
    { icon: Layers, label: "架构", value: node.arch || "—" },
    { icon: Server, label: "虚拟化", value: node.virt && node.virt !== "none" ? node.virt : "—" },
  ]

  return (
    <InfoCard title="硬件信息" className="h-full">
      <div className="flex h-full flex-col gap-3">
        <div className="min-w-0 rounded-lg bg-card-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Glyph icon={Cpu} box="sm" />
              <span>CPU</span>
            </div>
            <a
              href={passMarkUrl(node.cpu_name)}
              target="_blank"
              rel="noopener noreferrer"
              title="在 PassMark 查看该 CPU 的公开 CPU Mark 跑分与排行"
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-card px-1.5 py-0.5 text-2xs text-muted-foreground transition-colors hover:text-foreground"
            >
              CPU Mark
              <ExternalLink size={14} aria-hidden />
            </a>
          </div>
          <div className="mt-1.5 text-sm break-words">
            {model} <span className="text-muted-foreground">({node.cpu_cores} vCPU)</span>
          </div>
          <div
            className="mt-2 flex items-center gap-2"
            title={`参考公开天梯与型号代际的本地近似分级，不代表当前 ${node.cpu_cores} vCPU 的实测性能。${rating.description}`}
          >
            <span className={cn("shrink-0 text-xs font-bold", tone.text)}>{rating.tier}</span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-rail">
              <div
                className={cn("h-full rounded-full transition-[width] duration-700", tone.bar)}
                style={{ width: `${rating.percent}%` }}
              />
            </div>
            <span className="shrink-0 text-2xs text-muted-foreground">{rating.label}</span>
          </div>
        </div>

        <div className="grid flex-1 auto-rows-fr grid-cols-2 gap-3">
          {small.map((item) => <InfoCell key={item.label} {...item} />)}
        </div>
      </div>
    </InfoCard>
  )
}

function SystemCard({ node }: { node: Node }) {
  const uptime = node.metrics ? uptimeLong(node.metrics.uptime) : "—"
  return (
    <InfoCard title="系统信息" className="h-full">
      <div className="grid h-full auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2">
        <InfoCell
          icon={Monitor}
          label="操作系统"
          value={
            <span className="inline-flex items-center gap-1.5">
              <OsMark os={node.os} className="size-4" />
              <span>{osName(node.os) || "—"}</span>
            </span>
          }
        />
        <InfoCell icon={Terminal} label="内核版本" value={node.kernel || "—"} />
        <InfoCell icon={Clock} label="运行时间" value={uptime} />
        {/* The hub has no provider field. A dash is honest; guessing a vendor
            from a CPU name would be a different fact wearing this label. */}
        <InfoCell icon={Building2} label="厂商" value="—" />
      </div>
    </InfoCard>
  )
}

function StorageCard({ node }: { node: Node }) {
  return (
    <InfoCard title="存储信息">
      <div className="grid grid-cols-3 gap-3">
        <InfoCell icon={MemoryStick} label="内存" value={detailBytes(node.mem_total)} />
        <InfoCell icon={Repeat} label="内存交换" value={detailBytes(node.swap_total)} />
        <InfoCell icon={HardDrive} label="硬盘" value={detailBytes(node.disk_total)} />
      </div>
    </InfoCard>
  )
}

function NetworkCard({ node }: { node: Node }) {
  const peak = useDayPeak(node.id)
  const used = trafficUsed(node)
  const pct = trafficPct(node)
  const wash = pct === null ? "" : pct >= 80 ? "bg-destructive/30" : pct >= 60 ? "bg-warn/25" : "bg-ok/20"

  return (
    <InfoCard title="网络信息">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="relative min-w-0 overflow-hidden rounded-lg bg-card-2 p-2.5">
          {pct !== null && (
            <div
              aria-hidden
              className={cn("pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-300", wash)}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          )}
          <div className="relative">
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Glyph icon={ArrowUpDown} box="sm" />
              <span>总流量</span>
              <span className="ml-auto hidden text-3xs text-foreground/60 sm:inline">
                ↑ {detailBytes(node.total_tx)} / ↓ {detailBytes(node.total_rx)}
              </span>
            </div>
            <div className="mt-1 text-xs break-all sm:text-sm">
              {pct === null ? "无限流量" : `${detailBytes(used)} / ${detailBytes(node.traffic_limit)}`}
            </div>
            {peak && (
              <div className="mt-1 text-3xs text-muted-foreground">
                近一天峰值 <span className="text-ok">↑ {detailRate(peak.tx)}</span>{" "}
                <span className="text-brand">↓ {detailRate(peak.rx)}</span>
              </div>
            )}
          </div>
        </div>

        <InfoCell
          icon={Gauge}
          label="网络速率"
          value={
            <span className="inline-flex flex-wrap items-center gap-1">
              <span>↑ {node.metrics ? detailRate(node.metrics.net_tx) : "—"}</span>
              <span className="text-muted-foreground">·</span>
              <span>↓ {node.metrics ? detailRate(node.metrics.net_rx) : "—"}</span>
            </span>
          }
        />

      </div>
    </InfoCard>
  )
}

/** Four cards: hardware, system, storage, network, in that order. */
export function InfoGrid({ node }: { node: Node }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <HardwareCard node={node} />
      <SystemCard node={node} />
      <StorageCard node={node} />
      <NetworkCard node={node} />
    </div>
  )
}
