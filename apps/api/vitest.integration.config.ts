import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Opt-in suite that exercises real Postgres/Redis instead of mocks — run
// with `pnpm --filter @patchpilot/api test:integration` after
// `pnpm infra:dev:up`. Deliberately isolated from the dev databases the rest
// of the app (and this developer's own `pnpm dev`) uses:
//
//   - DATABASE_URL points at `patchpilot_test`, a SEPARATE database on the
//     same dev Postgres container — not a schema inside `patchpilot`, so a
//     bug in a test's cleanup step is physically incapable of touching real
//     tenant data (this project has twice lost real tenant rows to a script
//     that assumed it was safe to write to — see dataloss-incident memory).
//   - REDIS_URL points at logical DB 15 instead of the default 0, so session
//     keys can never collide with a real signed-in engineer's session.
//
// globalSetup provisions/migrates `patchpilot_test` once before the suite
// runs; it never touches `patchpilot` itself.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // Multiple files sharing one Postgres/Redis connection is safer run
    // serially than racing file-level parallelism against the same instance.
    fileParallelism: false,
    testTimeout: 15_000,
    globalSetup: [fileURLToPath(new URL("./src/test/integration-global-setup.ts", import.meta.url))],
    env: {
      DATABASE_URL: "postgres://patchpilot:patchpilot@localhost:5432/patchpilot_test",
      REDIS_URL: "redis://localhost:6379/15",
    },
  },
});
