import { useState } from "react"
import { ArrowLeft, ChevronLeft, ChevronRight, Star } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Glyph } from "@/components/ui/glyph"
import { Country, Status } from "@/components/NodeCard"
import type { Node } from "@/lib/api"
import { readFavorites, writeFavorites } from "@/lib/prefs"
import { cn } from "@/lib/utils"

/**
 * The top line of a node's page: the way back, the machine's identity, and the
 * controls that move between machines.
 *
 * It is a line rather than a card, unlike the list's cards: the page already has
 * sixteen cards below it, and a seventeenth held the same flag and name would
 * make the header compete with them. The controls keep one surface of their own
 * so the star, the arrows and the select read as one object, which is also what
 * gives the row its right edge on a wide screen.
 */
export function DetailHeader({ node, nodes, onBack, onOpen }: {
  node: Node
  /** The public fleet, already ordered. Empty on a page opened without a list. */
  nodes: Node[]
  onBack: () => void
  onOpen?: (id: number) => void
}) {
  const [favorites, setFavorites] = useState(readFavorites)
  const starred = favorites.includes(node.id)
  // The current node can be absent from the list while it is still loading, or
  // in a test that renders the header on its own. One entry keeps the select
  // honest instead of showing an empty box.
  const list = nodes.length ? nodes : [node]
  const index = list.findIndex((n) => n.id === node.id)
  const canMove = list.length > 1 && index >= 0 && onOpen != null

  const move = (offset: number) => {
    if (!canMove || !onOpen) return
    const next = list[(index + offset + list.length) % list.length]
    onOpen(next.id)
  }

  const toggleStar = () => {
    const next = starred ? favorites.filter((id) => id !== node.id) : [...favorites, node.id]
    setFavorites(next)
    writeFavorites(next)
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-1 size-8 rounded-md text-muted-foreground"
        aria-label="返回全部节点"
        title="返回全部节点"
        onClick={onBack}
      >
        <Glyph icon={ArrowLeft} />
      </Button>

      <div className="flex min-w-0 items-center gap-2.5">
        <Country node={node} />
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight" title={node.name}>
          {node.name}
        </h2>
        <Status node={node} />
        {/* Kept because it is the one fact that says whether a page is looking
            at a machine the operator is running today. Hidden on a phone, where
            the title and the controls need the whole row. */}
        {node.agent_version && (
          <Badge className="hidden font-normal text-muted-foreground sm:inline-flex">
            agent {node.agent_version}
          </Badge>
        )}
      </div>

      <div className="ml-auto flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-border-soft bg-card-2 p-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7 rounded-md", starred ? "text-warn" : "text-muted-foreground")}
          aria-label={starred ? "取消收藏当前节点" : "收藏当前节点"}
          aria-pressed={starred}
          title={starred ? "取消收藏" : "收藏节点"}
          onClick={toggleStar}
        >
          <Glyph icon={Star} box="sm" className={starred ? "fill-current" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md text-muted-foreground"
          aria-label="上一个节点"
          title="上一个节点"
          disabled={!canMove}
          onClick={() => move(-1)}
        >
          <Glyph icon={ChevronLeft} box="sm" />
        </Button>
        <select
          value={node.id}
          aria-label="切换节点"
          disabled={onOpen == null}
          onChange={(event) => {
            // The select is the reader's to tamper with; a value that is not a
            // node id would route the page to /node/NaN and strand it there.
            const id = Number(event.target.value)
            if (Number.isInteger(id)) onOpen?.(id)
          }}
          className="h-7 max-w-32 truncate rounded-md border-0 bg-transparent px-1 text-xs text-foreground outline-none sm:max-w-44"
        >
          {list.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-md text-muted-foreground"
          aria-label="下一个节点"
          title="下一个节点"
          disabled={!canMove}
          onClick={() => move(1)}
        >
          <Glyph icon={ChevronRight} box="sm" />
        </Button>
      </div>
    </div>
  )
}
