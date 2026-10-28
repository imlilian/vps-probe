/// <reference types="node" />
// One request per URL, however many readers ask: the hub runs four history
// scans at a time for the whole machine, and a node's page asks for two of them
// before the first paint. These pin the sharing (concurrent callers, a remount,
// a range switched back to) and the one thing that must never be shared -- a
// failure, because the retry button has to reach the hub.
import assert from "node:assert/strict"

import { historyGet, historyPeek } from "./history.ts"

/** Every URL the module actually asked for, in order. */
const calls: string[] = []
const answers = new Map<string, () => Response>()

globalThis.fetch = (async (input: RequestInfo | URL) => {
  // `api()` prefixes the path with `/api`; the hooks above it never do.
  const url = String(input).replace(/^\/api/, "")
  calls.push(url)
  const answer = answers.get(url)
  // Anything unexpected fails loudly rather than hanging the test.
  if (!answer) throw new Error(`unrequested ${url}`)
  return answer()
}) as typeof fetch

/** What the hub answers for `url` from now on. */
const serve = (url: string, body: unknown, status = 200) => {
  // The hub answers errors as one line of plain text, not as JSON.
  answers.set(url, () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": status === 200 ? "application/json" : "text/plain" },
  }))
}

const path = "/nodes/7/metrics?hours=24&points=144&series=metrics"

// Two callers, one request: the second arrives while the first is in flight.
serve(path, { metrics: [{ ts: 1 }], step: 600 })
const [a, b] = await Promise.all([historyGet<{ step: number }>(path), historyGet<{ step: number }>(path)])
assert.equal(a.step, 600)
assert.equal(b.step, 600)
assert.equal(calls.length, 1, "two callers share one request")
assert.deepEqual(historyPeek(path), { metrics: [{ ts: 1 }], step: 600 }, "and the answer is held")
console.log("history: one request serves every reader of the same URL")

// A later call inside the held age is answered from memory, not the hub.
assert.equal((await historyGet<{ step: number }>(path)).step, 600)
assert.equal(calls.length, 1, "a remount or a range switched back to costs nothing")

// A failure is never kept: the retry button must reach the hub again.
const failing = "/nodes/7/metrics?hours=720&points=180&series=metrics"
serve(failing, "查询历史的请求太多，稍后再试", 503)
let message = ""
try {
  await historyGet(failing)
} catch (error) {
  message = (error as Error).message
}
assert.equal(message, "查询历史的请求太多，稍后再试", "the hub's own words reach the reader")
assert.equal(historyPeek(failing), undefined, "a failure is not an answer")
serve(failing, { metrics: [], step: 14_400 })
const retried = await historyGet<{ step: number }>(failing)
assert.equal(retried.step, 14_400, "the retry asks again and succeeds")
assert.equal(calls.filter((url) => url === failing).length, 2, "one retry, one more request")
console.log("history: a failed window is retried, never replayed from memory")
