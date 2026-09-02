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
      "/auth": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
  },
});
