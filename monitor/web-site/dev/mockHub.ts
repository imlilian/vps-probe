import type { IncomingMessage, ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { createHash } from "node:crypto"

import type { Plugin, ViteDevServer } from "vite"

import { SITE_NAME, history, nodeList } from "./demoData.ts"

/**
 * A stand-in hub for `npm run dev:mock`.
 *
 * The page under development talks to the hub over four things: `/api/me`,
 * `/api/nodes`, `/api/nodes/{id}/metrics` and the `/api/ws` push. This answers
 * all four from `dev/demoData.ts`, so the front end runs with no hub, no agent
 * and no database -- which is the only way to look at a card's latency panel
 * without deploying to a machine that has real probes.
 *
 * It lives in the Vite config, so it exists only in the dev server: `vite
 * build` never sees it and nothing under `src/` imports it.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
/** The hub pushes every two seconds; the client's watchdog expects no slower. */
const PUSH_MS = 2000

function sendJson(res: ServerResponse, body: unknown) {
  const text = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.setHeader("cache-control", "no-store")
  res.end(text)
}

function sendText(res: ServerResponse, status: number, body: string) {
  res.statusCode = status
  res.setHeader("content-type", "text/plain; charset=utf-8")
  res.setHeader("cache-control", "no-store")
  res.end(body)
}

/** One unmasked server frame: text, with the smallest header that fits. */
function frame(text: string): Buffer {
  const body = Buffer.from(text)
  const head =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : body.length < 65536
        ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
        : (() => {
            const b = Buffer.alloc(10)
            b[0] = 0x81
            b[1] = 127
            b.writeBigUInt64BE(BigInt(body.length), 2)
            return b
          })()
  return Buffer.concat([head, body])
}

/**
 * The handshake and the push, by hand: `ws` is not a dependency of this
 * package, and adding one for the dev server alone would put a package in the
 * production lockfile that ships nothing. The page sends nothing back, so the
 * only client frame worth reading is a close.
 */
function attachSocket(server: ViteDevServer) {
  const http = server.httpServer
  if (!http) return
  const upgrade = (req: IncomingMessage, socket: Socket) => {
    const path = (req.url ?? "").split("?")[0]
    if (path !== "/api/ws") return
    const key = req.headers["sec-websocket-key"]
    if (typeof key !== "string") {
      socket.destroy()
      return
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64")
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    let timer: ReturnType<typeof setInterval> | null = null
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    // Frames carry the same body as `/api/nodes`, uncompressed: the page
    // appends `?gzip` and decodes only what arrives as binary, so text passes
    // straight through, exactly as a hub without the parameter answers.
    const push = () => {
      if (socket.destroyed) return stop()
      socket.write(frame(JSON.stringify({ nodes: nodeList() })))
    }
    timer = setInterval(push, PUSH_MS)
    push()
    socket.on("data", (chunk: Buffer) => {
      if ((chunk[0] & 0x0f) === 0x8) socket.end()
    })
    socket.on("close", stop)
    socket.on("error", stop)
  }
  http.on("upgrade", upgrade)
  http.on("close", () => http.off("upgrade", upgrade))
}

export function demoHub(): Plugin {
  return {
    name: "monitor-demo-hub",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://demo.local")
        if (!url.pathname.startsWith("/api/")) return next()

        if (url.pathname === "/api/me") {
          return sendJson(res, {
            authed: false,
            github: false,
            site_name: SITE_NAME,
            public_page: true,
            // Long enough for every range the detail page offers (max 30d).
            history_days: 30,
            // A documentation address (RFC 5737): the demo shows the footer's
            // fifth item without putting anyone's real address on a screen.
            ip: "203.0.113.42",
          })
        }
        if (url.pathname === "/api/nodes") return sendJson(res, { nodes: nodeList() })

        const match = url.pathname.match(/^\/api\/nodes\/(\d+)\/metrics$/)
        if (match) {
          const points = Number(url.searchParams.get("points") ?? 240)
          const hours = Number(url.searchParams.get("hours") ?? 6)
          const series = url.searchParams.get("series")
          const want = (name: "metrics" | "ping") => series === null || series === name
          const id = Number(match[1])
          const metrics = want("metrics") ? history(id, "metrics", hours, points) : null
          const ping = want("ping") ? history(id, "ping", hours, points) : null
          // The same five keys `api::metrics` answers with, each half empty when
          // the caller asked for the other one.
          return sendJson(res, {
            metrics: metrics?.metrics ?? [],
            ping: ping?.ping ?? [],
            probes: ping?.probes ?? {},
            loss: ping?.loss ?? {},
            step: ping?.step ?? metrics?.step ?? 60,
          })
        }

        // Anything else is a request the page should not be making; say so in
        // the console rather than hanging until the client's timeout.
        return sendText(res, 404, `演示模式未实现该接口：${url.pathname}`)
      })
      attachSocket(server)
    },
  }
}
