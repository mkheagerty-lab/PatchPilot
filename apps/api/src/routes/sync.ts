import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { auditSafe, assertSyncAllowed } from "@patchpilot/graph";
import { config } from "../config.js";
import { probeTenant, type TenantReachability, type LicenseStatus } from "../graph/licensing.js";
import {
  syncTenants,
  syncDevices,
  syncVulnerabilities,
  syncRecommendations,
  syncSoftwareInventory,
  syncMissingKbs,
  syncFeatureUpdateProfiles,
  backfillOsRecommendationVulnerabilities,
  type Engineer,
} from "../graph/sync.js";
import { captureTenantSnapshot } from "../posture/snapshot.js";
import { requirePermission } from "../auth/rbac.js";

/** Probe at most this many tenants' licensing at once, to stay under Graph throttling. */
const PROBE_CONCURRENCY = 8;

/** A single tenant's probe outcome, as returned to the client. */
interface TenantProbeResult {
  tenantId: string;
  reachability: TenantReachability;
  licenses: string[];
  licenseStatus: LicenseStatus;
  httpStatus?: number;
  detail?: string;
  licenseDetail?: string;
}

/**
 * Run `worker` over `items` with a bounded number in flight at once. Order of
 * results is not significant — each worker persists its own row.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Live ingestion routes (Phase 4).
 *
 * Engineer-triggered, on-demand sync of real tenant data into Postgres. These
 * are the only write paths that populate the read-only data routes once a real
 * Microsoft login replaces the demo fixtures.
 *
 * Hard DEMO_MODE gate (non-negotiable #9): in demo there is no real engineer
 * token and OBO is disabled, so every route here refuses with 409 rather than
 * touching Microsoft. Read-only-first (#6) holds — sync only GETs from Graph.
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // All sync routes require an authenticated engineer.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (config.DEMO_MODE) {
      return reply
        .code(409)
        .send({ error: "demo_mode", message: "Live sync is disabled in DEMO_MODE." });
    }
  });
  app.addHook("preHandler", requirePermission("settings:read"));

  const engineerOf = (req: { session: { engineer?: { upn: string; homeTenantId: string } } }): Engineer => ({
    upn: req.session.engineer!.upn,
    homeTenantId: req.session.engineer!.homeTenantId,
  });

  /**
   * Discover + upsert tenants (home MSP + GDAP customers), then probe each
   * consented tenant's licensing so feature gating (#4) reflects reality.
   *
   * Phase A: probing is concurrency-bounded (throttle mitigation) and, crucially,
   * honest — `detectLicenses` no longer throws but classifies each tenant's
   * reachability (reachable / consent-needed / throttled / unreachable). We
   * persist that classification alongside the detected licenses so the UI can
   * distinguish "we can't reach this tenant" from "this tenant has no licenses",
   * and the summary replaces the alarming "139 failed" with a real breakdown.
   */
  app.post(
    "/api/sync/tenants",
    { preHandler: requirePermission("settings:write") },
    async (req) => {
    const engineer = engineerOf(req);
    const startedAt = Date.now();
    let result: Awaited<ReturnType<typeof syncTenants>>;
    try {
      result = await syncTenants(engineer);
    } catch (err) {
      // Audit the failure too — "the engineer tried to discover tenants and it
      // broke" is exactly the event a silent throw would erase.
      await auditSafe({
        engineer: engineer.upn,
        // Discovery spans every tenant, so it belongs to none of them.
        tenantId: null,
        endpoint: "/api/sync/tenants",
        method: "POST",
        action: "tenant:discover",
        resourceType: "tenant",
        summary: "Tenant discovery failed",
        outcome: "failure",
        detail: err instanceof Error ? err.message : String(err),
        responseStatus: 500,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }

    const tenantRows = await db.select().from(tables.tenants);
    const consented = tenantRows.filter((t) => t.consentStatus === "consented");

    const probes = await mapWithConcurrency<typeof consented[number], TenantProbeResult>(
      consented,
      PROBE_CONCURRENCY,
      async (tenant) => {
        const probe = await probeTenant(engineer.upn, engineer.homeTenantId, tenant.tenantId);
        // Licensing degrades gracefully (#4): only overwrite a tenant's stored
        // licenses when we actually read them. An "unavailable" probe must not
        // wipe licenses detected on a previous (successful) run.
        await db
          .update(tables.tenants)
          .set(
            probe.licenseStatus === "detected"
              ? { reachability: probe.status, licenses: probe.licenses }
              : { reachability: probe.status },
          )
          .where(eq(tables.tenants.tenantId, tenant.tenantId));
        return {
          tenantId: tenant.tenantId,
          reachability: probe.status,
          licenses: probe.licenses,
          licenseStatus: probe.licenseStatus,
          httpStatus: probe.httpStatus,
          detail: probe.detail,
          licenseDetail: probe.licenseDetail,
        };
      },
    );

    const summary = {
      reachable: probes.filter((p) => p.reachability === "reachable").length,
      consentNeeded: probes.filter((p) => p.reachability === "consent-needed").length,
      throttled: probes.filter((p) => p.reachability === "throttled").length,
      unreachable: probes.filter((p) => p.reachability === "unreachable").length,
      // Of the reachable tenants, how many we could actually read licensing for.
      licensingUnavailable: probes.filter(
        (p) => p.reachability === "reachable" && p.licenseStatus === "unavailable",
      ).length,
    };

    // One row for the whole discovery run. Each probe already emits its own
    // api_call rows via graphGet; a per-tenant action row on top would put
    // hundreds of entries on the page for a single click.
    await auditSafe({
      engineer: engineer.upn,
      tenantId: null,
      endpoint: "/api/sync/tenants",
      method: "POST",
      action: "tenant:discover",
      resourceType: "tenant",
      summary: `Discovered ${result.count} tenants, probed ${probes.length} — ${summary.reachable} reachable, ${summary.consentNeeded} need consent`,
      outcome:
        summary.unreachable || summary.consentNeeded || summary.throttled ? "partial" : "success",
      detail: `unreachable ${summary.unreachable} · throttled ${summary.throttled} · licensing unavailable ${summary.licensingUnavailable}`,
      responseStatus: 200,
      latencyMs: Date.now() - startedAt,
    });

    return { tenants: result.count, probed: probes.length, summary, probes };
    },
  );

  /**
   * Sync one tenant's operational data: a full-refresh device snapshot followed
   * by a CVE-exposure upsert (which also attributes per-device vuln counts).
   */
  app.post<{ Params: { tenantId: string } }>(
    "/api/sync/:tenantId/data",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
    const engineer = engineerOf(req);
    const { tenantId } = req.params;

    // Only sync tenants we actually know about (discovered via /sync/tenants).
    const known = await db
      .select()
      .from(tables.tenants)
      .where(eq(tables.tenants.tenantId, tenantId));
    if (!known[0]) {
      return reply.code(404).send({ error: "unknown_tenant" });
    }

    // Free tier caps how many DISTINCT tenants may ever have data pulled in —
    // discovery/consent above is uncapped; this is the one gated "read" action.
    // See packages/graph/src/write-gate.ts's assertSyncAllowed.
    const syncGate = await assertSyncAllowed(known[0]);
    if (!syncGate.allowed) {
      return reply.code(403).send({ error: syncGate.reason });
    }

    // One audit row for the whole run, not one per sub-sync: six rows per click
    // would drown the page, and the six counts belong to a single decision.
    const startedAt = Date.now();
    try {
      const devices = await syncDevices(engineer, tenantId);
      const vulnerabilities = await syncVulnerabilities(engineer, tenantId);
      // Defender's consolidated recommendations (best-effort — zero if the tenant
      // lacks SecurityRecommendation.Read / MDE). This is the noise-reduced
      // "Update <product>" roll-up that fronts the per-CVE list.
      const recommendations = await syncRecommendations(engineer, tenantId);
      // Backfills per-CVE rows for recommendations the per-machine vulnerability
      // sync structurally can't cover (chiefly the OS product itself — Windows,
      // Windows Defender) — see the function doc for why. Runs after
      // syncRecommendations since it needs those freshly-upserted rows.
      const osBackfill = await backfillOsRecommendationVulnerabilities(engineer, tenantId);
      // Full software inventory (Ask 3) — best-effort, zero if the tenant lacks
      // Software.Read; covers software Defender enumerates but never emits a
      // CVE finding for, which the vulnerabilities sync misses.
      const softwareInventory = await syncSoftwareInventory(engineer, tenantId);
      // Per-device missing-KB list (Defender getmissingkbs) — best-effort, zero if
      // the tenant lacks Software.Read. Backs "By OS" / Missing KBs and the
      // Expedited Quality Update / Live Response KB-remediation dispatch paths.
      const missingKbs = await syncMissingKbs(engineer, tenantId);
      // Live-synced windowsFeatureUpdateProfiles — both PatchPilot's own campaigns
      // and any profile created directly in the Intune admin center or pre-dating
      // onboarding, so the Feature Update Campaigns page is never blind to a
      // profile that exists in Intune but that PatchPilot didn't create itself.
      const featureUpdateCampaigns = await syncFeatureUpdateProfiles(engineer, tenantId);

      // Stamp freshness only after a successful data pull, so the UI's "Last
      // synced" column reflects when devices + CVEs were actually ingested.
      const syncedAt = new Date();
      await db
        .update(tables.tenants)
        .set({ lastSyncedAt: syncedAt })
        .where(eq(tables.tenants.tenantId, tenantId));

      // Re-capture today's posture snapshot against the numbers that just
      // landed. Fire-and-forget with its own catch: the sync succeeded, and a
      // failure to rewrite a derived history row must not fail the request.
      void captureTenantSnapshot(tenantId, "post-sync", syncedAt).catch((err: unknown) => {
        console.error(`[sync] ${tenantId}: posture snapshot failed —`, err);
      });

      await auditSafe({
        engineer: engineer.upn,
        tenantId,
        endpoint: `/api/sync/${tenantId}/data`,
        method: "POST",
        action: "tenant:sync",
        resourceType: "tenant",
        resourceId: tenantId,
        resourceLabel: known[0].displayName,
        summary: `Synced ${known[0].displayName} — ${devices.count} devices, ${vulnerabilities.count} CVEs, ${recommendations.count} recommendations, ${softwareInventory.count} software, ${missingKbs.count} missing KBs, ${featureUpdateCampaigns.count} feature update campaigns`,
        outcome: "success",
        responseStatus: 200,
        latencyMs: Date.now() - startedAt,
      });

      return {
        tenantId,
        devices: devices.count,
        vulnerabilities: vulnerabilities.count,
        recommendations: recommendations.count,
        osVulnerabilityBackfill: osBackfill.count,
        softwareInventory: softwareInventory.count,
        missingKbs: missingKbs.count,
        featureUpdateCampaigns: featureUpdateCampaigns.count,
        lastSyncedAt: syncedAt.toISOString(),
      };
    } catch (err) {
      await auditSafe({
        engineer: engineer.upn,
        tenantId,
        endpoint: `/api/sync/${tenantId}/data`,
        method: "POST",
        action: "tenant:sync",
        resourceType: "tenant",
        resourceId: tenantId,
        resourceLabel: known[0].displayName,
        summary: `Sync of ${known[0].displayName} failed`,
        outcome: "failure",
        detail: err instanceof Error ? err.message : String(err),
        responseStatus: 500,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
    },
  );
}
