import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { audit } from "@patchpilot/graph";
import { compareWingetVersions } from "@patchpilot/shared";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";
import { demoSettings } from "./settings-store.js";

/**
 * Settings -> Updates: checks GitHub Releases for a newer PatchPilot version
 * and hands off "run now" / "schedule" to the `updater` sidecar (see
 * infra/updater/run.sh) via a row in `update_runs`.
 *
 * Split the same way notification-settings.ts splits "smtp": the
 * single-current-value version-check state lives in the `settings` KV table
 * under key "updates"; the per-run history/hand-off needs
 * `FOR UPDATE SKIP LOCKED` row-claiming a JSON blob can't give it, so it's the
 * dedicated `update_runs` table instead. See packages/db/src/schema.ts's
 * doc comment on that table for the fuller reasoning.
 */

const SETTINGS_KEY = "updates";

/** Re-check no more than once a minute, regardless of how many times an
 * engineer mashes "Check now" — the unauthenticated GitHub API rate limit is
 * shared across this whole instance's outbound IP. */
const CHECK_COOLDOWN_MS = 60_000;

/** Terminal-history rows to return to the client. */
const HISTORY_LIMIT = 20;

interface UpdatesSettingsStored {
  latestVersion: string | null;
  latestReleaseNotes: string | null;
  latestReleaseUrl: string | null;
  latestPublishedAt: string | null;
  lastCheckedAt: string | null;
}

const DEFAULTS: UpdatesSettingsStored = {
  latestVersion: null,
  latestReleaseNotes: null,
  latestReleaseUrl: null,
  latestPublishedAt: null,
  lastCheckedAt: null,
};

// Read once at module load, not per-request: the version never changes
// without a restart (a new image is exactly what ships a new version), and a
// module-load failure here should fail the boot loudly rather than 500 on
// first request. Four levels up from apps/api/src/routes/ reaches the repo
// root under both `pnpm dev` and infra/Dockerfile.api's /app WORKDIR layout.
const CURRENT_VERSION: string = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
).version;

async function loadStored(): Promise<UpdatesSettingsStored> {
  if (config.DEMO_MODE) {
    return { ...DEFAULTS, ...(demoSettings[SETTINGS_KEY] as Partial<UpdatesSettingsStored> | undefined) };
  }
  const [row] = await db.select().from(tables.settings).where(eq(tables.settings.key, SETTINGS_KEY));
  return { ...DEFAULTS, ...((row?.value as Partial<UpdatesSettingsStored> | undefined) ?? {}) };
}

async function saveStored(next: UpdatesSettingsStored): Promise<void> {
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

/** GitHub's release JSON, reduced to the fields this feature reads. */
interface GithubRelease {
  tag_name: string;
  body: string | null;
  html_url: string;
  published_at: string;
}

/**
 * Hits the public, unauthenticated GitHub Releases API. Returns null (never
 * throws) on any failure — a rate limit or a network blip must leave the
 * previously-stored state untouched, not clear it.
 */
async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const res = await fetch(config.GITHUB_RELEASES_URL, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      console.error(`[updates] GitHub Releases check failed: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as GithubRelease;
    if (!json.tag_name) return null;
    return json;
  } catch (err) {
    console.error("[updates] GitHub Releases check failed:", err);
    return null;
  }
}

/** A git tag like "v0.2.0" — compareWingetVersions doesn't understand the
 * leading "v", so it's stripped before every comparison/storage use. */
function stripTagPrefix(tag: string): string {
  return tag.replace(/^v/i, "");
}

async function findPendingRun() {
  if (config.DEMO_MODE) return null;
  const [row] = await db
    .select()
    .from(tables.updateRuns)
    .where(inArray(tables.updateRuns.status, ["queued", "running"]))
    .orderBy(tables.updateRuns.scheduledAt)
    .limit(1);
  return row ?? null;
}

async function loadHistory() {
  if (config.DEMO_MODE) return [];
  return db
    .select()
    .from(tables.updateRuns)
    .where(inArray(tables.updateRuns.status, ["succeeded", "failed"]))
    .orderBy(desc(tables.updateRuns.createdAt))
    .limit(HISTORY_LIMIT);
}

export async function updateSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  /** A row is a "rollback" when it was aimed at an older version than what
   *  was running at the time it was created — computed here, once, rather
   *  than re-derived client-side (same spirit as `updateAvailable` below).
   *  Rows created before `fromVersion` existed have nothing to compare
   *  against, so they fall back to "update" (today's target-only display). */
  function classifyRun<T extends { targetVersion: string; fromVersion: string | null }>(
    run: T,
  ): T & { kind: "update" | "rollback" } {
    const kind =
      run.fromVersion && compareWingetVersions(stripTagPrefix(run.targetVersion), run.fromVersion) < 0
        ? "rollback"
        : "update";
    return { ...run, kind };
  }

  /** Shared by GET and POST .../check — both hand the client the exact same
   *  assembled view, since a check's response is just "the current view,
   *  possibly refreshed" plus one extra `checked` flag. */
  async function buildView(stored: UpdatesSettingsStored) {
    const [pendingRun, history] = await Promise.all([findPendingRun(), loadHistory()]);
    const updateAvailable =
      stored.latestVersion !== null &&
      compareWingetVersions(stripTagPrefix(stored.latestVersion), CURRENT_VERSION) > 0;

    return {
      currentVersion: CURRENT_VERSION,
      ...stored,
      updateAvailable,
      pendingRun: pendingRun ? classifyRun(pendingRun) : null,
      history: history.map(classifyRun),
    };
  }

  app.get("/api/settings/updates", async () => buildView(await loadStored()));

  app.post(
    "/api/settings/updates/check",
    { preHandler: requirePermission("settings:write") },
    async (req) => {
      const existing = await loadStored();
      const sinceLastCheck = existing.lastCheckedAt
        ? Date.now() - new Date(existing.lastCheckedAt).getTime()
        : Infinity;
      if (sinceLastCheck < CHECK_COOLDOWN_MS) {
        return { ...(await buildView(existing)), checked: false };
      }

      const release = await fetchLatestRelease();
      const next: UpdatesSettingsStored = release
        ? {
            latestVersion: stripTagPrefix(release.tag_name),
            latestReleaseNotes: release.body,
            latestReleaseUrl: release.html_url,
            latestPublishedAt: release.published_at,
            lastCheckedAt: new Date().toISOString(),
          }
        : // Network/rate-limit failure: only bump lastCheckedAt so a fresh
          // "Check now" click doesn't spin forever on a stuck cooldown, while
          // every other field — including a real latestVersion already
          // found — is left exactly as it was.
          { ...existing, lastCheckedAt: new Date().toISOString() };
      await saveStored(next);

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: "/api/settings/updates/check",
        method: "POST",
        action: "update:check",
        resourceType: "setting",
        resourceId: SETTINGS_KEY,
        resourceLabel: SETTINGS_KEY,
        summary: release
          ? `Checked for updates — latest is v${next.latestVersion}`
          : "Checked for updates — GitHub Releases was unreachable",
        outcome: release ? "success" : "failure",
        responseStatus: 200,
      });

      return { ...(await buildView(next)), checked: true };
    },
  );

  const ScheduleBody = z.object({
    scheduledAt: z.string().datetime(),
  });

  /** Shared queue-insert for run-now/schedule (forward updates, targetVersion
   *  defaults to the latest known release) and rollback (targetVersion is an
   *  explicit past version). Always stamps `fromVersion: CURRENT_VERSION` so
   *  history can tell the two apart later, independent of what's running by
   *  the time someone looks. */
  async function triggerRun(
    scheduledAt: Date,
    engineer: string,
    targetVersion?: string,
  ): Promise<{ status: number; body: unknown }> {
    if (config.DEMO_MODE) {
      return {
        status: 503,
        body: {
          error: "demo_unsupported",
          detail: "Triggering an update needs the updater sidecar. Set DEMO_MODE=false.",
        },
      };
    }
    let resolvedTarget = targetVersion;
    if (resolvedTarget === undefined) {
      const stored = await loadStored();
      const updateAvailable =
        stored.latestVersion !== null &&
        compareWingetVersions(stripTagPrefix(stored.latestVersion), CURRENT_VERSION) > 0;
      if (!updateAvailable || !stored.latestVersion) {
        return { status: 400, body: { error: "no_update_available" } };
      }
      resolvedTarget = `v${stored.latestVersion}`;
    }
    const pending = await findPendingRun();
    if (pending) {
      return { status: 409, body: { error: "update_already_pending", pendingRun: pending } };
    }

    const [row] = await db
      .insert(tables.updateRuns)
      .values({
        targetVersion: resolvedTarget,
        fromVersion: CURRENT_VERSION,
        status: "queued",
        triggeredBy: engineer,
        scheduledAt,
      })
      .returning();

    return { status: 202, body: row };
  }

  app.post(
    "/api/settings/updates/run-now",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const result = await triggerRun(new Date(), req.currentUser!.upn);
      if (result.status < 300) {
        const row = result.body as typeof tables.updateRuns.$inferSelect;
        await audit({
          engineer: req.currentUser!.upn,
          endpoint: "/api/settings/updates/run-now",
          method: "POST",
          action: "update:run-now",
          resourceType: "update-run",
          resourceId: row.id,
          resourceLabel: row.targetVersion,
          summary: `Triggered an immediate update to ${row.targetVersion}`,
          outcome: "success",
          responseStatus: result.status,
        });
      }
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/api/settings/updates/schedule",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      const parsed = ScheduleBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const scheduledAt = new Date(parsed.data.scheduledAt);
      if (scheduledAt.getTime() <= Date.now()) {
        return reply.code(400).send({ error: "scheduled_at_must_be_future" });
      }

      const result = await triggerRun(scheduledAt, req.currentUser!.upn);
      if (result.status < 300) {
        const row = result.body as typeof tables.updateRuns.$inferSelect;
        await audit({
          engineer: req.currentUser!.upn,
          endpoint: "/api/settings/updates/schedule",
          method: "POST",
          action: "update:schedule",
          resourceType: "update-run",
          resourceId: row.id,
          resourceLabel: row.targetVersion,
          summary: `Scheduled an update to ${row.targetVersion} for ${scheduledAt.toISOString()}`,
          outcome: "success",
          responseStatus: result.status,
        });
      }
      return reply.code(result.status).send(result.body);
    },
  );

  const RollbackBody = z.object({
    targetVersion: z.string().min(1),
  });

  app.post(
    "/api/settings/updates/rollback",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Rolling back needs the updater sidecar. Set DEMO_MODE=false.",
        });
      }
      const parsed = RollbackBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }
      const { targetVersion } = parsed.data;
      if (targetVersion === `v${CURRENT_VERSION}`) {
        return reply.code(400).send({ error: "already_current" });
      }
      // Only ever offer a version this instance itself ran clean before — no
      // GitHub lookup needed to know the tag exists, and no way to typo a
      // rollback into a version that was never actually deployed here.
      const [known] = await db
        .select({ id: tables.updateRuns.id })
        .from(tables.updateRuns)
        .where(
          and(eq(tables.updateRuns.targetVersion, targetVersion), eq(tables.updateRuns.status, "succeeded")),
        )
        .limit(1);
      if (!known) {
        return reply.code(400).send({ error: "not_a_known_version" });
      }

      const result = await triggerRun(new Date(), req.currentUser!.upn, targetVersion);
      if (result.status < 300) {
        const row = result.body as typeof tables.updateRuns.$inferSelect;
        await audit({
          engineer: req.currentUser!.upn,
          endpoint: "/api/settings/updates/rollback",
          method: "POST",
          action: "update:rollback",
          resourceType: "update-run",
          resourceId: row.id,
          resourceLabel: row.targetVersion,
          summary: `Rolled back to ${row.targetVersion}`,
          outcome: "success",
          responseStatus: result.status,
        });
      }
      return reply.code(result.status).send(result.body);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/settings/updates/runs/:id",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(503).send({
          error: "demo_unsupported",
          detail: "Update runs need a database. Set DEMO_MODE=false.",
        });
      }
      const [deleted] = await db
        .delete(tables.updateRuns)
        .where(and(eq(tables.updateRuns.id, req.params.id), eq(tables.updateRuns.status, "queued")))
        .returning();
      if (!deleted) {
        // Distinguish "never existed" from "already claimed/running" so the
        // client can tell an admin why the cancel didn't happen.
        const [row] = await db
          .select({ status: tables.updateRuns.status })
          .from(tables.updateRuns)
          .where(eq(tables.updateRuns.id, req.params.id));
        if (!row) return reply.code(404).send({ error: "not_found" });
        return reply.code(409).send({ error: "not_cancellable", status: row.status });
      }

      await audit({
        engineer: req.currentUser!.upn,
        endpoint: `/api/settings/updates/runs/${req.params.id}`,
        method: "DELETE",
        action: "update:cancel",
        resourceType: "update-run",
        resourceId: deleted.id,
        resourceLabel: deleted.targetVersion,
        summary: `Cancelled the scheduled update to ${deleted.targetVersion}`,
        outcome: "success",
        responseStatus: 204,
      });

      return reply.code(204).send();
    },
  );
}

/**
 * Used by updates/auto-check.ts's background poll — same fetch/compare/save
 * logic as POST .../check above, minus the cooldown guard (the scheduler
 * already paces itself) and the audit call (the caller owns that, so it can
 * attribute success/failure to SYSTEM_ACTORS.updateCheck itself, mirroring
 * catalog/auto-refresh.ts's refreshOnce()). Throws on a failed GitHub fetch
 * after still recording the attempt's timestamp, so the caller's catch block
 * has a real error to log/audit.
 */
export async function checkForUpdateOnce(): Promise<{ latestVersion: string | null }> {
  const release = await fetchLatestRelease();
  if (!release) {
    const existing = await loadStored();
    await saveStored({ ...existing, lastCheckedAt: new Date().toISOString() });
    throw new Error("GitHub Releases was unreachable");
  }
  const next: UpdatesSettingsStored = {
    latestVersion: stripTagPrefix(release.tag_name),
    latestReleaseNotes: release.body,
    latestReleaseUrl: release.html_url,
    latestPublishedAt: release.published_at,
    lastCheckedAt: new Date().toISOString(),
  };
  await saveStored(next);
  return { latestVersion: next.latestVersion };
}
