import "@fastify/session";
import type { Role } from "@patchpilot/shared";

export interface SessionEngineer {
  upn: string;
  displayName: string;
  homeTenantId: string;
}

/**
 * The PatchPilot-side identity: who this session's UPN resolves to in the
 * `engineers` table (or the DEMO_MODE store) and what role they hold.
 *
 * Deliberately NOT part of the session cookie — see auth/current-user.ts.
 * It's resolved fresh on every request so a role change or a disable takes
 * effect on the very next request rather than waiting out the session TTL.
 * Absent until that preHandler runs; `auth/rbac.ts`'s guard is what actually
 * enforces its presence, route handlers should not assume it's set.
 */
export interface CurrentUser {
  id: string;
  upn: string;
  displayName: string;
  role: Role;
}

declare module "fastify" {
  interface Session {
    engineer?: SessionEngineer;
    /**
     * Double-submit CSRF token, handed to the frontend by GET /auth/me and
     * echoed back as the X-CSRF-Token header on every mutating request (see
     * server.ts's csrf preHandler hook). Lazily generated on first /auth/me
     * call rather than at login so sessions that predate this field still
     * get one instead of being locked out of every mutation.
     */
    csrfToken?: string;
  }
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
}
