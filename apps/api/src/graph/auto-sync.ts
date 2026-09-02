import { eq, inArray, lte } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { config } from "../config.js";
import { listEngineersWithCache, auditSafe } from "@patchpilot/graph";
import { SYSTEM_ACTORS } from "@patchpilot/shared";
import { sendAlertEmail } from "@patchpilot/shared/alerting";
import {
  syncDevices,
  syncVulnerabilities,
  syncRecommendations,
  syncSoftwareInventory,
  syncMissingKbs,
  syncFeatureUpdateProfiles,
  syncQualityUpdateProfiles,
  syncQualityUpdatePolicies,
  syncUpdateRingProfiles,
  syncDriverUpdateProfiles,
  type Engineer,
} from "./sync.js";
import { captureTenantSnapshot } from "../posture/snapshot.js";

/**
 * Background auto-sync (Phase 4) — keeps reachable customer tenants' data fresh
 * without an engineer clicking "Sync Data".
 *
 * Why this is even possible headlessly: customer tenants are reached via the
 * Secure Application Model (acquireTokenForCustomerTenant), which redeems an
 * engineer's *persisted* refresh token from the Redis MSAL cache against the
 * customer-tenant authority. That needs only the engineer's UPN + the cache —
 * NO live session. So a timer-driven loop can mint customer-tenant tokens and
 * run the same audited, read-only `graphGet` sync the manual route uses.
 *
 * The MSP **home** tenant still needs live-session OBO and will fail here — that
 * is fine and expected. We only target tenants marked `reachability = 'reachable'`
 * (customers), and any per-tenant failure is caught so one bad tenant or one
 * expired engineer cache never aborts the cycle.
 *
 * Non-negotiables honored:
 *  - #9 DEMO_MODE: the loop never starts in demo (zero-dependency, no Redis/Graph).
 *  - #6 read-only-first: only GETs Graph/Defender; never flips `tenants.readOnly`.
 *  - #3 audit: every read goes through `graphGet`, recording the acting engineer.
 *  - per-tenant isolation: each tenant synced independently under one engineer's
 *    delegated, GDAP-scoped token.
 */

/** Lives in the API process because that's where all auth/token/graph wiring is. */
const FIRST_CYCLE_DELAY_MS = 30_000;

/** How many tenants to sync concurrently, to stay under Graph/Defender throttling. */
const SYNC_CONCURRENCY = 4;

/** Run `worker` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!);
    }
  });
  await Promise.all(runners);
}

/**
 * Whether the last check found zero engineers with a cached session — tracked
 * so the audit row below fires once on the 0-\>N transition (and once on the
 * N-\>0 recovery), not on every 30s/hourly tick. Shared between runCycle and
 * drainResyncRequests since they're the same underlying signal.
 */
let backgroundAccessUnavailable = false;

/**
 * Surfaces the "nobody can reach any tenant right now" state, which used to be
 * a silent early-return — worse than the audited per-tenant failure case,
 * since a fresh deploy or an all-engineers-logged-out window produced no
 * visible signal at all. Edge-triggered to avoid spamming one row per tick.
 */
async function reportBackgroundAccess(upns: string[]): Promise<void> {
  if (upns.length === 0) {
    if (backgroundAccessUnavailable) return;
    backgroundAccessUnavailable = true;
    await auditSafe({
      engineer: SYSTEM_ACTORS.autoSync,
      actorType: "system",
      tenantId: null,
      endpoint: "auto-sync:background-access",
      method: "SYNC",
      action: "background-access:unavailable",
      resourceType: "background-access",
      summary:
        "No engineer has a cached background-access session — auto-sync and engineer-owned schedules can't run until someone signs in to PatchPilot",
      outcome: "failure",
      responseStatus: 503,
    });
    void sendAlertEmail("api", {
      key: "background-access-unavailable",
      subject: "Auto-sync stopped — no engineer has a cached session",
      body: "No engineer has a cached background-access session. Auto-sync and engineer-owned schedules can't run until someone signs in to PatchPilot.",
    });
    return;
  }
  if (backgroundAccessUnavailable) {
    backgroundAccessUnavailable = false;
    await auditSafe({
      engineer: SYSTEM_ACTORS.autoSync,
      actorType: "system",
      tenantId: null,
      endpoint: "auto-sync:background-access",
      method: "SYNC",
      action: "background-access:restored",
      resourceType: "background-access",
      summary: `Background access restored — ${upns.length} engineer(s) now have a cached session`,
      outcome: "success",
      responseStatus: 200,
    });
  }
}

/**
 * Sync one tenant's devices + vulnerabilities, trying each candidate engineer in
 * turn until one succeeds (an engineer's GDAP grant or cached RT may have lapsed
 * even while another's still works). Stamps `lastSyncedAt` only on success, so the
 * UI's freshness column matches the manual route's semantics exactly.
 */
async function syncOneTenant(
  engineers: Engineer[],
  tenantId: string,
  action: "tenant:auto-sync" | "tenant:resync",
): Promise<boolean> {
  const startedAt = Date.now();
  // Each engineer attempted is a fallback, not a separate decision — so one
  // audit row per tenant per cycle, with the attempts in `detail`. At
  // SYNC_CONCURRENCY × every tenant × every interval, per-attempt rows would
  // make this the loudest thing in the log by a wide margin.
  const failures: string[] = [];

  for (const engineer of engineers) {
    try {
      const devices = await syncDevices(engineer, tenantId);
      const vulnerabilities = await syncVulnerabilities(engineer, tenantId);
      const recommendations = await syncRecommendations(engineer, tenantId);
      const softwareInventory = await syncSoftwareInventory(engineer, tenantId);
      // Best-effort like softwareInventory above — zero if the tenant lacks
      // Software.Read.All. Without this, missing_kbs only ever gets refreshed
      // by the manual "Sync Data" route, which nobody has reason to click once
      // auto-sync is keeping lastSyncedAt looking fresh on its own.
      const missingKbs = await syncMissingKbs(engineer, tenantId);
      // Live-synced windowsFeatureUpdateProfiles — both PatchPilot's own campaigns
      // and any profile created directly in the Intune admin center or pre-dating
      // onboarding, matching the manual sync route's behavior.
      const featureUpdateCampaigns = await syncFeatureUpdateProfiles(engineer, tenantId);
      // Live-synced windowsQualityUpdateProfiles ("Expedite" policies) and
      // windowsQualityUpdatePolicies ("Windows quality update" policies) —
      // separate Graph resources sharing one local table, split by policyType.
      const qualityUpdateProfiles = await syncQualityUpdateProfiles(engineer, tenantId);
      const qualityUpdatePolicies = await syncQualityUpdatePolicies(engineer, tenantId);
      // Read-only mirrors: no PatchPilot write path exists for either, so this
      // sync is purely for visibility in the Windows Updates hub.
      const updateRingProfiles = await syncUpdateRingProfiles(engineer, tenantId);
      const driverUpdateProfiles = await syncDriverUpdateProfiles(engineer, tenantId);
      await db
        .update(tables.tenants)
        .set({ lastSyncedAt: new Date() })
        .where(eq(tables.tenants.tenantId, tenantId));
      console.log(
        `[auto-sync] ${tenantId}: ${devices.count} devices, ${vulnerabilities.count} vulns, ${recommendations.count} recs, ${softwareInventory.count} software, ${missingKbs.count} missing KBs, ${featureUpdateCampaigns.count} feature update campaigns, ${qualityUpdateProfiles.count} expedite policies, ${qualityUpdatePolicies.count} quality update policies, ${updateRingProfiles.count} update rings, ${driverUpdateProfiles.count} driver update profiles (as ${engineer.upn})`,
      );

      // Re-capture today's posture snapshot now that the numbers have moved.
      // Fire-and-forget with its own catch: the sync succeeded, and a failure to
      // rewrite a derived history row must never turn that into a failed sync.
      void captureTenantSnapshot(tenantId, "post-sync").catch((err: unknown) => {
        console.error(`[auto-sync] ${tenantId}: posture snapshot failed —`, err);
      });

      await auditSafe({
        // The scheduler decided this, not a person — but the delegated identity
        // the reads actually ran under is recorded in `detail`, because that is
        // whose GDAP grant touched the customer tenant.
        engineer: SYSTEM_ACTORS.autoSync,
        actorType: "system",
        tenantId,
        endpoint: `auto-sync:${tenantId}`,
        method: "SYNC",
        action,
        resourceType: "tenant",
        resourceId: tenantId,
        summary: `${action === "tenant:resync" ? "Post-remediation re-sync" : "Auto-sync"} — ${devices.count} devices, ${vulnerabilities.count} CVEs, ${recommendations.count} recommendations, ${softwareInventory.count} software, ${missingKbs.count} missing KBs, ${featureUpdateCampaigns.count} feature update campaigns, ${qualityUpdateProfiles.count} expedite policies, ${qualityUpdatePolicies.count} quality update policies, ${updateRingProfiles.count} update rings, ${driverUpdateProfiles.count} driver update profiles`,
        outcome: "success",
        detail: `Ran as ${engineer.upn}${failures.length ? ` after ${failures.length} failed attempt(s)` : ""}`,
        responseStatus: 200,
        latencyMs: Date.now() - startedAt,
      });

      return true;
    } catch (err) {
      // Try the next engineer; only log at debug-ish volume so a tenant nobody
      // can currently reach doesn't spam the log every cycle.
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${engineer.upn}: ${message}`);
      console.log(`[auto-sync] ${tenantId}: ${engineer.upn} failed — ${message}`);
    }
  }

  console.log(`[auto-sync] ${tenantId}: no engineer could sync this cycle`);
  await auditSafe({
    engineer: SYSTEM_ACTORS.autoSync,
    actorType: "system",
    tenantId,
    endpoint: `auto-sync:${tenantId}`,
    method: "SYNC",
    action,
    resourceType: "tenant",
    resourceId: tenantId,
    summary: `${action === "tenant:resync" ? "Post-remediation re-sync" : "Auto-sync"} failed — no engineer could reach this tenant`,
    outcome: "failure",
    detail: failures.join(" · "),
    responseStatus: 502,
    latencyMs: Date.now() - startedAt,
  });
  void sendAlertEmail("api", {
    key: `tenant-sync-failed:${tenantId}`,
    subject: `Tenant sync failed: ${tenantId}`,
    body: `No engineer could sync tenant ${tenantId} this cycle:\n\n${failures.join("\n")}`,
  });
  return false;
}

/**
 * One full pass: find engineers with a usable cached session, find reachable
 * tenants, and sync each tenant under whichever engineer's delegated credential
 * works. Bounded concurrency; every failure is contained per tenant.
 */
async function runCycle(): Promise<void> {
  const upns = await listEngineersWithCache();
  await reportBackgroundAccess(upns);
  if (upns.length === 0) {
    console.log("[auto-sync] no engineers with a cached session — skipping cycle");
    return;
  }

  // All MSP engineers share the MSP home tenant; customer access is delegated
  // through their GDAP roles regardless.
  const engineers: Engineer[] = upns.map((upn) => ({
    upn,
    homeTenantId: config.ENTRA_TENANT_ID,
  }));

  const reachable = await db
    .select()
    .from(tables.tenants)
    .where(eq(tables.tenants.reachability, "reachable"));
  if (reachable.length === 0) {
    console.log("[auto-sync] no reachable tenants — skipping cycle");
    return;
  }

  console.log(
    `[auto-sync] cycle start: ${reachable.length} reachable tenants, ${engineers.length} engineer(s)`,
  );
  let ok = 0;
  await mapWithConcurrency(reachable, SYNC_CONCURRENCY, async (tenant) => {
    if (await syncOneTenant(engineers, tenant.tenantId, "tenant:auto-sync")) ok++;
  });
  console.log(`[auto-sync] cycle done: ${ok}/${reachable.length} tenants synced`);
}

/**
 * How often to look for due post-remediation re-syncs. Much faster than the
 * hourly cycle because the whole point is to notice Defender clearing a finding
 * close to when it happens; each tick is a cheap indexed read that usually finds
 * nothing.
 */
const RESYNC_DRAIN_INTERVAL_MS = 5 * 60_000;

/**
 * Run any re-syncs the worker asked for after a successful remediation (see
 * `resync_requests` in the schema — the worker can't sync directly because all
 * auth/token/Graph wiring lives in this process).
 *
 * Requests are claimed by deletion before the sync runs, so a drain that outruns
 * its interval can't sync the same tenant twice over. A failed sync therefore
 * loses that request rather than retrying it — deliberate: a job schedules four
 * requests across six hours, and the hourly cycle is still underneath them all,
 * so retry logic here would only add a way for an unreachable tenant to be
 * re-attempted forever.
 */
async function drainResyncRequests(): Promise<void> {
  const due = await db
    .select()
    .from(tables.resyncRequests)
    .where(lte(tables.resyncRequests.dueAt, new Date()));
  if (due.length === 0) return;

  // Resolve engineers BEFORE claiming: with nobody able to sync, leaving the
  // requests in place lets the next tick try again instead of dropping them.
  const upns = await listEngineersWithCache();
  await reportBackgroundAccess(upns);
  if (upns.length === 0) {
    console.log("[auto-sync] resync: no engineers with a cached session — leaving requests queued");
    return;
  }
  const engineers: Engineer[] = upns.map((upn) => ({ upn, homeTenantId: config.ENTRA_TENANT_ID }));

  await db.delete(tables.resyncRequests).where(
    inArray(
      tables.resyncRequests.id,
      due.map((r) => r.id),
    ),
  );

  // Several requests for one tenant collapse into a single sync — four jobs on
  // the same tenant land four rows at each offset, and one pull answers them all.
  const reachable = await db
    .select({ tenantId: tables.tenants.tenantId })
    .from(tables.tenants)
    .where(eq(tables.tenants.reachability, "reachable"));
  const reachableIds = new Set(reachable.map((t) => t.tenantId));
  const tenantIds = [...new Set(due.map((r) => r.tenantId))].filter((id) => reachableIds.has(id));
  if (tenantIds.length === 0) return;

  console.log(
    `[auto-sync] resync: ${due.length} due request(s) -> ${tenantIds.length} tenant(s) (${due
      .map((r) => r.reason)
      .join(", ")})`,
  );
  await mapWithConcurrency(tenantIds, SYNC_CONCURRENCY, async (tenantId) => {
    await syncOneTenant(engineers, tenantId, "tenant:resync");
  });
}

/**
 * Start the background scheduler. Returns a stop function for graceful shutdown.
 *
 * No-op (returns a stop that does nothing) in DEMO_MODE or when the interval is
 * ≤ 0, so the demo stays zero-dependency and operators can disable the loop. A
 * `cycleRunning` guard prevents overlap if a cycle outruns the interval.
 */
export function startAutoSync(): () => void {
  if (config.DEMO_MODE) {
    console.log("[auto-sync] disabled (DEMO_MODE)");
    return () => {};
  }
  const intervalMinutes = config.AUTO_SYNC_INTERVAL_MINUTES;
  if (intervalMinutes <= 0) {
    console.log("[auto-sync] disabled (AUTO_SYNC_INTERVAL_MINUTES=0)");
    return () => {};
  }

  let cycleRunning = false;
  let interval: NodeJS.Timeout | undefined;

  /**
   * One guard for both loops: they sync the same tenants against the same
   * throttled Graph/Defender endpoints, so they must never run concurrently. A
   * drain skipped because a full cycle is in flight loses nothing — that cycle
   * is already pulling every reachable tenant, including this one.
   */
  const runExclusive = async (label: string, body: () => Promise<void>): Promise<void> => {
    if (cycleRunning) {
      console.log(`[auto-sync] previous cycle still running — skipping this ${label}`);
      return;
    }
    cycleRunning = true;
    try {
      await body();
    } catch (err) {
      // A cycle should never crash the process; log and wait for the next tick.
      console.error(`[auto-sync] ${label} error:`, err);
      const message = err instanceof Error ? err.message : String(err);
      void sendAlertEmail("api", {
        key: `auto-sync-cycle-error:${label}`,
        subject: `Auto-sync ${label} threw`,
        body: `The auto-sync ${label} raised an unexpected error and was skipped this tick:\n\n${message}`,
      });
    } finally {
      cycleRunning = false;
    }
  };

  const tick = (): Promise<void> => runExclusive("cycle", runCycle);
  const drainTick = (): Promise<void> => runExclusive("resync drain", drainResyncRequests);

  // Delay the first cycle so boot (server listen, migrations) settles first.
  const firstCycle = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), intervalMinutes * 60_000);
  }, FIRST_CYCLE_DELAY_MS);

  // Post-remediation catch-up runs on its own faster clock, independent of the
  // first-cycle delay: a request can already be due at boot (queued by the worker
  // before the API last restarted).
  const drainInterval = setInterval(() => void drainTick(), RESYNC_DRAIN_INTERVAL_MS);

  console.log(
    `[auto-sync] enabled — every ${intervalMinutes} min (first run in 30s), post-remediation resync check every ${RESYNC_DRAIN_INTERVAL_MS / 60_000} min`,
  );

  return () => {
    clearTimeout(firstCycle);
    clearInterval(drainInterval);
    if (interval) clearInterval(interval);
  };
}
