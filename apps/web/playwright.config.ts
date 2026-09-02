import { defineConfig, devices } from "@playwright/test";

// Dedicated, non-default ports so this suite can never collide with — or
// accidentally attach to — a real developer-run dev server that might be
// pointed at live tenant data. reuseExistingServer is always false for the
// same reason: a stray process already bound to 4501/5501 should fail loudly
// (EADDRINUSE) rather than have the suite silently run against it.
const API_PORT = 4501;
const WEB_PORT = 5501;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      // DEMO_MODE is forced here (not read from .env) so the suite is safe to
      // run on a machine whose .env holds real production secrets/DB — this
      // spawns a fully isolated, in-memory-fixture API instance no matter
      // what the local environment is otherwise configured for.
      command: "pnpm --filter @patchpilot/api dev",
      cwd: "../..",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DEMO_MODE: "true",
        API_PORT: String(API_PORT),
        LOG_LEVEL: "warn",
      },
    },
    {
      // Port is set via E2E_WEB_PORT (read by vite.config.ts), not a CLI
      // --port flag — pnpm on this machine forwards a literal "--" through to
      // vite instead of stripping it, which silently breaks CLI flag passing.
      command: "pnpm --filter @patchpilot/web dev",
      cwd: "../..",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        E2E_API_PORT: String(API_PORT),
        E2E_WEB_PORT: String(WEB_PORT),
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
