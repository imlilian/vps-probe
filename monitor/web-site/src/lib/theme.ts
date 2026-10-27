import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import { readPref, writePref } from "@/lib/prefs"

export type ThemeMode = "light" | "dark" | "system"

/** Press order of the toggle. */
const MODES: ThemeMode[] = ["light", "dark", "system"]

/** Shown in the toggle's tooltip and read out by a screen reader. */
export const MODE_LABEL: Record<ThemeMode, string> = {
  light: "明亮",
  dark: "深色",
  system: "跟随系统",
}

/** Shared with the panel at `/admin/`, which reads it raw. */
const KEY = "theme"

const DARK_MEDIA = matchMedia("(prefers-color-scheme: dark)")
// Must match `--background` in index.css: slate-100 and slate-950.
const THEME_COLOR = { light: "#f1f5f9", dark: "#020618" }

/**
 * Three states rather than two: light, dark, and whatever the system says. The
 * third is what a fourth press would otherwise be missing -- without it, a
 * visitor whose desktop flips at sunset has to flip the page by hand.
 *
 * An absent key means `system`, and clicking back to `system` writes the word
 * rather than removing the key: the panel at `/admin/` shares this key on one
 * origin and reads an absent value as "follow the system" too, but a value it
 * can name is easier to reason about than a hole.
 */
function readMode(): ThemeMode {
  const saved = readPref(KEY)
  return saved === "light" || saved === "dark" || saved === "system" ? saved : "system"
}

function subscribeSystem(notify: () => void) {
  DARK_MEDIA.addEventListener("change", notify)
  return () => DARK_MEDIA.removeEventListener("change", notify)
}

/**
 * The visitor's choice, the system's while there is none, and the two things
 * that follow from it: the `dark` class on `<html>` and the browser's own
 * chrome colour.
 */
export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode)

  // The system's answer is subscribed to rather than copied into state: a flip
  // landing between the first render and the effect that would have attached
  // the listener is otherwise never heard, and the next one is a day away.
  const system = useSyncExternalStore(subscribeSystem, () => DARK_MEDIA.matches)
  const dark = mode === "system" ? system : mode === "dark"

  // The panel in another tab is the same key on the same origin; without this,
  // a theme changed there would leave this tab on the mode it loaded with.
  useEffect(() => {
    const sync = () => setMode(readMode())
    addEventListener("storage", sync)
    return () => removeEventListener("storage", sync)
  }, [])

  // Switched with every transition held. Cards, buttons and badges fade their
  // colours over 150 ms while everything else changes at once, so a meter bar
  // already in the dark palette would vanish into a card still white.
  useEffect(() => {
    const hold = document.createElement("style")
    hold.textContent = "*,*::before,*::after{transition:none!important}"
    document.head.append(hold)
    const root = document.documentElement.classList
    root.toggle("dark", dark)
    // `light` is pinned too, not left to the absence of `dark`: the stylesheet
    // follows the system until one of the two is set, and a visitor who chose
    // light on a dark desktop would otherwise keep the dark palette.
    root.toggle("light", !dark)
    // Resolves the new colours while transitions are off, so removing the
    // hold starts none.
    void document.body.offsetWidth
    hold.remove()

    // The address bar and task switcher follow the page rather than the system,
    // so the choice holds outside the viewport as well. The two media-scoped
    // tags in index.html cover the first paint; this one has no media
    // attribute, so it wins over both from here on.
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    if (!meta) {
      meta = document.createElement("meta")
      meta.name = "theme-color"
      document.head.append(meta)
    }
    meta.content = dark ? THEME_COLOR.dark : THEME_COLOR.light
  }, [dark])

  // light -> dark -> system -> light: one fixed order, so the button always
  // means the same thing. A visitor who never chose starts on `system`; their
  // first press pins light, which on a dark desktop repaints the page and on a
  // bright one only changes the icon -- the icon is the receipt either way.
  //
  // `cycle` is kept for the one-button toggle the panel still draws; the status
  // page's slider picks a mode outright, because three states behind one press
  // is a control nobody can aim at.
  const choose = useCallback((next: ThemeMode) => {
    setMode(next)
    writePref(KEY, next)
  }, [])

  const cycle = useCallback(() => {
    setMode((current) => {
      const next = MODES[(MODES.indexOf(current) + 1) % MODES.length]
      writePref(KEY, next)
      return next
    })
  }, [])

  return { mode, dark, cycle, choose }
}
