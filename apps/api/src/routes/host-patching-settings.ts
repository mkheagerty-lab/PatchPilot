import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { demoSettings } from "./settings-store.js";

/**
 * Settings -> Server Health -> Resources: desired-state config for the two
 * opt-in OS-patching toggles the `updater` sidecar pushes out to the host
 * every poll (see infra/updater/run.sh's rewrite_apt_managed_dropin() and
 * sync_docker_daemon_json()). Pure admin-editable config with no
 * row-claiming semantics, so — same as update-settings.ts's own local
 * saveStored/loadStored pair — this lives in the shared `settings` KV table
 * under key "host-patching" rather than a dedicated table.
 *
 * Both toggles default OFF: nothing changes for an existing customer's host
 * on upgrading to this release until an admin opts in here. See
 * packages/db/src/schema.ts's hostStatus/hostRebootRequests tables for the
 * read-only status half of this feature (apps/api/src/routes/server-health.ts).
 */

const SETTINGS_KEY = "host-patching";

interface HostPatchingSettingsStored {
  autoRebootEnabled: boolean;
  autoRebootTimeUtc: string;
  dockerAutoUpdateEnabled: boolean;
  dockerLiveRestoreEnabled: boolean;
}

const DEFAULTS: HostPatchingSettingsStored = {
  autoRebootEnabled: false,
  autoRebootTimeUtc: "03:30",
  dockerAutoUpdateEnabled: false,
  dockerLiveRestoreEnabled: false,
};

async function loadStored(): Promise<HostPatchingSettingsStored> {
  if (config.DEMO_MODE) {
    return { ...DEFAULTS, ...(demoSettings[SETTINGS_KEY] as Partial<HostPatchingSettingsStored> | undefined) };
  }
  const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, SETTINGS_KEY));
  return { ...DEFAULTS, ...((row?.value as Partial<HostPatchingSettingsStored> | undefined) ?? {}) };
}

async function saveStored(next: HostPatchingSettingsStored): Promise<void> {
  const value = next as unknown as Record<string, unknown>;
  if (config.DEMO_MODE) {
    demoSettings[SETTINGS_KEY] = value;
    return;
  }
  await db
    .insert(tables.settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
}

// 24h "HH:MM" — same shape the updater's own defensive re-check in run.sh
// falls back on if this is ever bypassed (it isn't, since this is the only
// write path, but the redundancy is cheap).
const TimeUtc = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h, UTC)");

const HostPatchingBody = z.object({
  autoRebootEnabled: z.boolean(),
  autoRebootTimeUtc: TimeUtc,
  dockerAutoUpdateEnabled: z.boolean(),
  dockerLiveRestoreEnabled: z.boolean(),
});

export async function hostPatchingSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  app.get("/api/settings/host-patching", async () => {
    return { demoMode: config.DEMO_MODE, ...(await loadStored()) };
  });

  app.post(
    "/api/settings/host-patching",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Changing host patching config needs the updater sidecar. Set DEMO_MODE=false.",
        });
      }
      const parsed = HostPatchingBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const next = parsed.data;
      // Server-side enforcement, not just a UI nicety: including Docker's
      // apt repo in unattended-upgrades' scope without live-restore first
      // means a docker-ce upgrade restarts dockerd and kills every container
      // at once — the exact dangerous combination that motivated gating this
      // at all.
      if (next.dockerAutoUpdateEnabled && !next.dockerLiveRestoreEnabled) {
        return reply.code(400).send({ error: "live_restore_required" });
      }

      await saveStored(next);

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/settings/host-patching",
        method: "POST",
        action: "server:host-patching-updated",
        resourceType: "setting",
        resourceId: SETTINGS_KEY,
        resourceLabel: SETTINGS_KEY,
        summary: `Updated host patching settings (auto-reboot ${next.autoRebootEnabled ? "on" : "off"}, Docker auto-update ${next.dockerAutoUpdateEnabled ? "on" : "off"}, live-restore ${next.dockerLiveRestoreEnabled ? "on" : "off"})`,
        outcome: "success",
        responseStatus: 200,
      });

      return { demoMode: false, ...next };
    },
  );
}
