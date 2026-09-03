/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// E2E_API_PORT/E2E_WEB_PORT let the Playwright config point this dev server
// (and its proxy) at an isolated, DEMO_MODE-only API instance instead of a
// real dev/prod pair — see playwright.config.ts. Read from env rather than
// CLI flags because `pnpm --filter ... dev -- --port ...` does not reliably
// forward flags through to vite on this pnpm version. Unset for normal
// `pnpm dev`, which always targets the usual 5173/4000.
const apiPort = process.env.E2E_API_PORT || "4000";
const webPort = Number(process.env.E2E_WEB_PORT) || 5173;

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: webPort,
    strictPort: !!process.env.E2E_WEB_PORT,
    // Lets the dev server answer to the cloudflared tunnel hostname (see
    // patchpilot-licensing's vite.config.ts for the same pattern) — Vite
    // rejects unrecognized Host headers by default as a DNS-rebinding guard.
    // Leading dot allows any subdomain of patchpilot365.com, not just the
    // current dev./admin. split, so a future tunnel hostname doesn't need
    // another restart.
    allowedHosts: [".patchpilot365.com"],
    proxy: {
      // Proxy API + auth to the Fastify backend in dev so cookies are same-origin.
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
      "/auth": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        // changeOrigin rewrites the Host header this proxy sends upstream to
        // localhost:<apiPort>, so apps/api can never see the browser's real
        // Host through it otherwise. The OAuth redirect_uri apps/api builds
        // (see apps/api/src/auth/origin.ts) needs that real host to round-trip
        // a login started from an allow-listed alternate origin (e.g. the
        // cloudflared tunnel hostname) back to itself instead of always
        // landing on PUBLIC_URL. Only forwarded if the incoming request
        // already carried it (from cloudflared) — never synthesized here.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.headers.host) proxyReq.setHeader("x-forwarded-host", req.headers.host);
            const proto = req.headers["x-forwarded-proto"];
            if (proto) proxyReq.setHeader("x-forwarded-proto", proto);
          });
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
