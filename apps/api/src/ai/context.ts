import { db, tables, demoTenants, type TenantRow } from "@patchpilot/db";
import { config } from "../config.js";
import type { CurrentUser } from "../types.js";

/**
 * Everything a tool needs to enforce the app's normal RBAC boundary and
 * nothing else — no DB handle, no query builder. Every tool in tools.ts takes
 * one of these plus its own validated args, so the same object that gates
 * `requirePermission()` in a normal route is what gates a tool call here.
 */
export interface ToolContext {
  user: CurrentUser;
  /** Entra tenant GUIDs this engineer can currently reach — the exact same
   * set `useTenant()`'s tenant switcher offers in the web app. A tool must
   * never return data for a tenantId outside this set, regardless of what
   * the model asks for. */
  reachableTenantIds: ReadonlySet<string>;
}

async function loadTenants(): Promise<TenantRow[]> {
  return config.DEMO_MODE ? demoTenants : db.select().from(tables.tenants);
}

/** Same "reachable" definition the tenant switcher and every all-tenants
 * aggregate in the app already use — see tenants.reachability. */
export async function loadReachableTenantIds(): Promise<ReadonlySet<string>> {
  const all = await loadTenants();
  return new Set(all.filter((t) => t.reachability === "reachable").map((t) => t.tenantId));
}

export async function loadReachableTenants(): Promise<TenantRow[]> {
  const all = await loadTenants();
  return all.filter((t) => t.reachability === "reachable");
}

/** Thrown by a tool's `run()` for an expected refusal (permission, unknown/
 * unreachable tenant, bad args a zod schema couldn't catch on its own) — the
 * registry turns this into a `{ error }` tool result instead of a crash, so
 * the model can explain the refusal to the user in its own words. */
export class ToolError extends Error {}
