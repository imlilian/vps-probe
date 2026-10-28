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
export function NodeDetail({ node, historyDays, onBack, nodes = [], onOpen }: {
  node: Node
  historyDays: number
  onBack: () => void
  /** The public fleet, already ordered, for the header's switcher. */
  nodes?: Node[]
  onOpen?: (id: number) => void
}) {
  return (
    <div className="space-y-4">
      <DetailHeader node={node} nodes={nodes} onBack={onBack} onOpen={onOpen} />

      {/* The note the operator wrote for visitors. The hub has sent this on
          every frame since the monorepo merge and nothing rendered it, while
          the panel-only `remark` was drawn here instead: a visitor saw no note
          at all, and a signed-in one saw a note written for themselves. The
          public one wins; `remark` is the fallback for a hub that predates it. */}
      {(node.public_remark || node.remark) && (
        <p className="rounded-lg bg-card-2 px-3 py-2 text-sm whitespace-pre-wrap">{node.public_remark || node.remark}</p>
      )}

      <MetricGrid node={node} />
      <InfoGrid node={node} />
      <LoadSection node={node} historyDays={historyDays} />
      <LatencySection node={node} historyDays={historyDays} />
    </div>
  )
}
