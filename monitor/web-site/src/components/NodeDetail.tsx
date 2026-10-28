import type { Node } from "@/lib/api"
import { DetailHeader } from "@/components/detail/DetailHeader"
import { InfoGrid } from "@/components/detail/InfoGrid"
import { LatencySection } from "@/components/detail/LatencySection"
import { LoadSection } from "@/components/detail/LoadSection"
import { MetricGrid } from "@/components/detail/MetricGrid"

/**
 * The page's composition: header, optional note, the sixteen live figures, the
 * four information cards, then the load and latency halves. Each half owns its
 * range and its request; this component only places them.
 */
export function NodeDetail({ node, at = 0, historyDays, onBack, nodes = [], onOpen }: {
  node: Node
  /** The millisecond the hub built the frame carrying `node`; 0 when it does not say. */
  at?: number
  historyDays: number
  onBack: () => void
  /** The public fleet, already ordered, for the header's switcher. */
  nodes?: Node[]
  onOpen?: (id: number) => void
}) {
  return (
    <div className="space-y-4">
      <DetailHeader node={node} nodes={nodes} onBack={onBack} onOpen={onOpen} />

      {/* The note the operator wrote *for visitors*, and nothing else. `remark`
          is the panel's own and the hub keeps it out of every public frame, but
          reading it here would make this page the one place that could publish
          it -- one hub change, or one proxy that merges the two frames, and
          "恢复密码在 1Password" is on the internet. A hub old enough to have no
          `public_remark` simply shows no note. */}
      {node.public_remark && (
        <p className="rounded-lg bg-card-2 px-3 py-2 text-sm whitespace-pre-wrap">{node.public_remark}</p>
      )}

      <MetricGrid node={node} />
      <InfoGrid node={node} />
      <LoadSection node={node} at={at} historyDays={historyDays} />
      <LatencySection node={node} historyDays={historyDays} />
    </div>
  )
}
