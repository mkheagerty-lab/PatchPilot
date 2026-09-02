import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/**
 * Runs once before the whole test:integration suite (see
 * vitest.integration.config.ts). Provisions `patchpilot_test` — a database
 * separate from `patchpilot` on the same dev Postgres container — and brings
 * it up to date with the real Drizzle migrations, so the integration tests
 * exercise the actual current schema, not a hand-maintained fixture schema
 * that could silently drift from it.
 *
 * Connects to the `postgres` maintenance database to issue CREATE DATABASE
 * (patchpilot_test doesn't exist yet on a fresh container) — never to
 * `patchpilot` itself.
 */
const ADMIN_URL = "postgres://patchpilot:patchpilot@localhost:5432/postgres";
const TEST_DB_URL = "postgres://patchpilot:patchpilot@localhost:5432/patchpilot_test";

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/test -> src -> api -> apps -> repo root -> packages/db/drizzle
const MIGRATIONS_FOLDER = resolve(__dirname, "../../../../packages/db/drizzle");

export default async function setup() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin`CREATE DATABASE patchpilot_test`;
  } catch (err) {
    // 42P04 = database already exists — expected on every run after the first.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await admin.end();
  }

  const migrationClient = postgres(TEST_DB_URL, { max: 1 });
  try {
    await migrate(drizzle(migrationClient), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await migrationClient.end();
  }
}
