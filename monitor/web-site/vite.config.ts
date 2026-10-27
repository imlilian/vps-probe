import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

import { demoHub } from "./dev/mockHub.ts"

// `npm run dev:mock` (`--mode mock`) runs the page on the sample fleet in
// `dev/`, with no hub, no agent and no database behind it: the only way to look
// at a latency panel before a machine with real probes exists. In that mode the
// proxy is dropped, since there is no hub to forward to.
export default defineConfig(({ mode }) => {
  const demo = mode === "mock"
  return {
    plugins: [...(demo ? [demoHub()] : []), react(), tailwindcss()],
    // import.meta.dirname rather than new URL(...).pathname: the latter is
    // URL-encoded, so a checkout under a path containing a space or a non-ASCII
    // name resolves to %20 and the alias silently points nowhere.
    resolve: { alias: { "@": import.meta.dirname + "/src" } },
    build: {
      chunkSizeWarningLimit: 900,
      // Flags stay files. Vite would inline every one under 4 KiB -- all of them --
      // as a data URL, and because the page imports the whole set, all of them
      // would ship in the entry chunk whichever flags a hub's nodes need.
      assetsInlineLimit: (file) => (file.includes("/country-flag-icons/") ? false : undefined),
    },
    // A theme reads public data only, so any hub with its status page open can
    // serve as the source: MONITOR_HUB=https://hub.example.com npm run dev.
    // changeOrigin sends that hub its own name as Host, which the proxy or CDN in
    // front of it routes by.
    server: demo
      ? {}
      : { proxy: { "/api": { target: process.env.MONITOR_HUB || "http://127.0.0.1:9911", changeOrigin: true, ws: true } } },
  }
})
