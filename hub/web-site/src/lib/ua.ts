/**
 * What a user agent string says about the machine reading the page: the system
 * and the browser, both as the words a person would use.
 *
 * Two facts, no version numbers. A visitor knows which browser they are holding;
 * what they cannot see is what the page made of it, and a version string in a
 * footer invites a bug report about a number nobody can check. Nor does this
 * pretend to be analytics: nothing is sent anywhere, the string comes from the
 * browser and stays in the page.
 *
 * Both readers are ordered, and the order is the whole difficulty:
 *   - Edge and Opera both carry `Chrome/`, Firefox on iOS carries `FxiOS/`, and
 *     Chrome on iOS carries `CriOS/` -- a rule that tests for `Chrome/` first
 *     would call all four "Chrome".
 *   - Every iOS browser carries `like Mac OS X`, so `iPhone` has to be read
 *     before `Mac OS X`, and Android before `Linux` for the same reason.
 *
 * The strings are the interface's own words rather than the UA's: `Windows`,
 * not `Windows NT 10.0`, which is Windows 10 and 11 both.
 */

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
]

const BROWSERS: [RegExp, string][] = [
  [/Edg[A-Z]?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/FxiOS\/|Firefox\//, "Firefox"],
  [/CriOS\//, "Chrome"],
  [/Chrome\/|Chromium\//, "Chrome"],
  [/Safari\//, "Safari"],
]

const first = (table: [RegExp, string][], ua: string) => table.find(([pattern]) => pattern.test(ua))?.[1]

export function systemOf(ua: string): string {
  return first(SYSTEMS, ua) ?? "未知系统"
}

export function browserOf(ua: string): string {
  return first(BROWSERS, ua) ?? "未知浏览器"
}
