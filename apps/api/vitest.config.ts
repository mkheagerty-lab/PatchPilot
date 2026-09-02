import { defineConfig } from "vitest/config";

// Default `pnpm test` — fast, fully-mocked unit tests only. Integration
// tests (see vitest.integration.config.ts) hit a real Postgres/Redis and are
// opt-in via `pnpm test:integration`, never swept into this run: CI and every
// engineer's inner loop must be able to run `pnpm test` with no Docker
// services up at all.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});
