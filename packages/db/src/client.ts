import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  }
  return url;
}

// Lazy singleton: the connection pool is created on first real use, not at
// import time. This lets DEMO_MODE import @patchpilot/db (for fixtures) without
// requiring a database — db.* is never touched when serving in-memory data.
let _db: PostgresJsDatabase<typeof schema> | null = null;

function getDb(): PostgresJsDatabase<typeof schema> {
  if (!_db) {
    const queryClient = postgres(databaseUrl(), { max: 10 });
    _db = drizzle(queryClient, { schema });
  }
  return _db;
}

// Proxy so existing `db.select()...` call sites keep working unchanged while the
// underlying pool stays lazy.
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    // Bind methods to the real instance so drizzle's internal `this` works.
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export { schema };
export type Database = PostgresJsDatabase<typeof schema>;
