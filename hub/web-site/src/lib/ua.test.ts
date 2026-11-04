// The footer's reading of a user agent string. Two rules, each with an order
// that a naive implementation gets wrong, so each is asserted against the string
// that would fool it.
//
// Run it with `npm test`: Node strips the types itself, so this needs no runner.
// Nothing imports it, so the bundle never includes it.
import { browserOf, systemOf } from "./ua.ts"

let failed = 0
function eq(got: unknown, want: unknown, what: string) {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)]
  if (a !== b) {
    failed++
    console.error(`✗ ${what}\n    得到 ${a}\n    期望 ${b}`)
  }
}

const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15"
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1"
const CHROME_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1"
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0"
const OPERA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0"

// Edge before Chrome: `Edg/` also matches `Chrome/`.
eq(browserOf(EDGE_WIN), "Edge", "Edge 排在 Chrome 前面")
eq(browserOf(CHROME_WIN), "Chrome", "Chrome 本体")
eq(browserOf(OPERA_WIN), "Opera", "Opera 也带 Chrome/")
// iOS browsers carry their own tokens, so the desktop rules must not answer first.
eq(browserOf(CHROME_IPHONE), "Chrome", "iOS 上的 Chrome 是 CriOS")
eq(browserOf(SAFARI_IPHONE), "Safari", "iOS Safari 不带 Chrome/")
eq(browserOf(FIREFOX_ANDROID), "Firefox", "Android 上的 Firefox")
// Safari last: every Chromium string also claims Safari.
eq(browserOf(SAFARI_MAC), "Safari", "macOS Safari 落到最后一条")

// iOS before macOS, Android before Linux: both carry the wider token.
eq(systemOf(SAFARI_IPHONE), "iOS", "iPhone 带着 like Mac OS X，仍读成 iOS")
eq(systemOf(CHROME_IPHONE), "iOS", "iOS 不因浏览器而变")
eq(systemOf(SAFARI_MAC), "macOS", "Macintosh 读成 macOS")
eq(systemOf(EDGE_WIN), "Windows", "Windows 不带版本号")
eq(systemOf(FIREFOX_ANDROID), "Android", "Android 不读成 Linux")

// A hub behind a client that sends nothing, or a bot: words, not blanks.
eq(systemOf(""), "未知系统", "空 UA")
eq(browserOf(""), "未知浏览器", "空 UA")
eq(systemOf("curl/8.5.0"), "未知系统", "curl 没有系统可读")
eq(browserOf("curl/8.5.0"), "未知浏览器", "curl 没有浏览器可读")

if (failed) {
  console.error(`\n${failed} 项不通过`)
  throw new Error("UA 解析校验未通过")
}
console.log("the footer reads the system before the token it is hiding in")
console.log("and the browser by the most specific claim first")
