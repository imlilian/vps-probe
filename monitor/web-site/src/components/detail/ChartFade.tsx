/**
 * The area under a line, fading downward: strong where it meets the line and
 * nearly gone at the base, instead of one flat wash.
 *
 * `id` has to be unique per chart: an SVG fragment resolves to the first match
 * in the document, and five panels sharing "fade" would all take CPU's.
 */
export function ChartFade({ id, color }: { id: string; color: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity={0.26} />
        <stop offset="100%" stopColor={color} stopOpacity={0.02} />
      </linearGradient>
    </defs>
  )
}
