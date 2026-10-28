/**
 * `localStorage`, with the two guards this site needs and nothing else.
 *
 * Storage can be switched off for a site -- then even reading it throws -- and a
 * write can fail on a full or read-only store. A preference is a convenience:
 * losing it must never break the click that set it. Values stay plain strings
 * rather than JSON, because the theme key is shared with the panel at `/admin/`,
 * which reads it raw.
 *
 * The list's two preferences live here rather than in the components that show
 * them: one place to read the keys, and the parsers next to the defaults they
 * fall back to. Both are the reader's settings, so they stay in the browser: the
 * site operator has nothing to configure here, and the hub has no theme settings
 * to store them in.
 */
import { formatOrder, parseOrder, type Density, type Order } from "./sort.ts"

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Passing null removes the key, which is how a caller returns to the default. */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // The choice then lasts until the page is closed.
  }
}

/**
 * Key and direction in one entry (`cpu:desc`) rather than the two a reader might
 * expect: they always change together, and two writes are two chances to be read
 * apart -- a `sort` of `cpu` beside a `dir` left over from `name` would open the
 * page in a direction nobody asked for.
 */
const ORDER = "sort"
const DENSITY = "density"
const FAVORITES = "favorite-nodes"

export function readOrder(): Order {
  return parseOrder(readPref(ORDER))
}

export function writeOrder(order: Order): void {
  writePref(ORDER, formatOrder(order))
}

export function readDensity(): Density {
  return readPref(DENSITY) === "compact" ? "compact" : "standard"
}

export function writeDensity(density: Density): void {
  // `standard` is written rather than removed: a named value is easier to read
  // back than a hole, the same argument the theme key makes.
  writePref(DENSITY, density)
}

/**
 * The nodes the reader starred, in the order they were starred. A set rather
 * than a list is what the header needs, but the array keeps the order stable
 * for a future "my favourites" filter. Anything that is not an integer id is
 * dropped: this is the reader's own convenience, not a contract with the hub.
 */
export function readFavorites(): number[] {
  try {
    const raw = readPref(FAVORITES)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((id): id is number => Number.isInteger(id)))]
  } catch {
    return []
  }
}

export function writeFavorites(ids: number[]): void {
  writePref(FAVORITES, JSON.stringify([...new Set(ids.filter((id) => Number.isInteger(id)))]))
}
