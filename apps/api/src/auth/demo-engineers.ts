import { randomUUID } from "node:crypto";
import type { Role, UserStatus } from "@patchpilot/shared";

/**
 * DEMO_MODE's in-memory stand-in for the `engineers` table.
 *
 * The real table intentionally has no demo/seed fixture (see
 * packages/db/src/demo-data.ts) — DEMO_MODE never touches Postgres at all, the
 * same way @patchpilot/graph's `demoAudits` keeps the audit log in memory
 * instead of writing rows. Without a store here, Settings -> Users would be
 * empty and unusable in the mode most people actually run PatchPilot in.
 *
 * Seeded with exactly the account server.ts's DEMO_MODE hook injects into the
 * session (see server.ts), as an active admin, so current-user resolution has
 * a real row to find on the very first request.
 */
export interface DemoEngineer {
  id: string;
  upn: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  email: string | null;
  invitedBy: string | null;
  invitedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  receiveJobAlerts: boolean;
  theme: "light" | "dark";
}

const seededAt = new Date().toISOString();

/** The UPN server.ts's DEMO_MODE hook injects — kept in one place so the
 * store and the session-injection hook can't drift apart. */
export const DEMO_ENGINEER_UPN = "demo.engineer@blackiron.example";

export const demoEngineers: DemoEngineer[] = [
  {
    id: randomUUID(),
    upn: DEMO_ENGINEER_UPN,
    displayName: "Demo Engineer",
    role: "admin",
    status: "active",
    email: null,
    invitedBy: "system:startup",
    invitedAt: seededAt,
    lastLoginAt: seededAt,
    createdAt: seededAt,
    updatedAt: seededAt,
    receiveJobAlerts: true,
    theme: "light",
  },
];

export function findDemoEngineerByUpn(upn: string): DemoEngineer | undefined {
  return demoEngineers.find((e) => e.upn === upn);
}
