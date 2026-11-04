import { useEffect, useRef, useState } from "react"

/**
 * True once the element is within `rootMargin` of the viewport. Used to keep
 * the latency request off the first paint: the section sits below six charts,
 * and a visitor who never scrolls has no use for its history.
 */
export function useInView<T extends Element>(rootMargin = "600px") {
  const ref = useRef<T | null>(null)
  const [seen, setSeen] = useState(false)

  useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === "undefined") {
      // A browser test without IO still gets its data, just not deferred.
      queueMicrotask(() => setSeen(true))
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setSeen(true)
        observer.disconnect()
      }
    }, { rootMargin })
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen, rootMargin])

  return [ref, seen] as const
}
