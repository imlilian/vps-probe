/**
 * `localStorage`, with the two guards this site needs and nothing else.
 *
 * Storage can be switched off for a site -- then even reading it throws -- and a
 * write can fail on a full or read-only store. A preference is a convenience:
 * losing it must never break the click that set it. Values stay plain strings
 * rather than JSON, because the theme key is shared with the panel at `/admin/`,
 * which reads it raw.
 */

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
