/**
 * Run-time re-authorization for a queued report job.
 *
 * `POST /api/reports` already checked all of this at request time, but a job
 * can sit queued behind a busy Chromium or a slow narration long enough for
 * the picture to change: the engineer can be disabled or demoted, or a named
 * tenant can lose reachability. Same rationale — and mostly the same
 * queries — as `assertStillAuthorized` in the retired `ai-report-worker.ts`.
 *
 * The one thing that changed on purpose: which permission is a hard refusal.
 * Every report needs `operations:read` — that's the gate the whole feature
 * sits behind, so losing it fails the job outright. `ai:use` is checked
 * separately by `canNarrate` below and is NOT a hard refusal: decision #4 in
 * the reports plan is explicit that a permission problem is refused (the api
 * route already refuses `narrate:true` without `ai:use` before a job is even
 * enqueued) while a capability problem degrades — so an engineer who loses
 * `ai:use` while their job sits queued still gets their report, just without
 * AI narration, rather than having it fail outright for a request they made
 * while still entitled to it.
 */
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { can, type ReportJob, type Role } from "@patchpilot/shared";

export class ReportAuthError extends Error {}

export interface AuthorizedEngineer {
  upn: string;
  role: Role;
}

export async function assertStillAuthorized(payload: ReportJob): Promise<AuthorizedEngineer> {
  const [engineer] = await db
    .select()
    .from(tables.engineers)
    .where(eq(tables.engineers.upn, payload.engineer))
    .limit(1);
  if (!engineer || engineer.status !== "active") {
    throw new ReportAuthError(`Engineer ${payload.engineer} is no longer active`);
  }
  if (!can(engineer.role, "operations:read")) {
    throw new ReportAuthError(`Engineer ${payload.engineer}'s role no longer includes operations:read`);
  }

  if (payload.tenantId) {
    const [tenant] = await db
      .select()
      .from(tables.tenants)
      .where(eq(tables.tenants.tenantId, payload.tenantId))
      .limit(1);
    if (!tenant || tenant.reachability !== "reachable") {
      throw new ReportAuthError(`Tenant ${payload.tenantId} is no longer reachable`);
    }
  }

  return { upn: engineer.upn, role: engineer.role as Role };
}

/** Whether this engineer may still receive AI narration — checked
 * independently of `assertStillAuthorized` so losing it degrades the report
 * rather than failing it (see the module doc above). */
export function canNarrate(engineer: AuthorizedEngineer): boolean {
  return can(engineer.role, "ai:use");
}
