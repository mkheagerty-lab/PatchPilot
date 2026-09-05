import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  db,
  tables,
  demoTenants,
  demoDevices,
  demoDeviceVulnerabilities,
  demoVulnerabilities,
  demoRecommendations,
} from "@patchpilot/db";
import {
  computeSla,
  slaChipLabel,
  friendlyProductName,
  annotateForeignName,
  normalizeTitle,
  resolveDisplaySoftwareName,
  deviceSlaCompliance,
  normalizeSlaThresholds,
  CLIENT_BUILDS,
  type SlaThresholds,
  type Severity,
} from "@patchpilot/shared";
import { audit, resolveEffectiveEntitlement } from "@patchpilot/graph";
import { config } from "../config.js";
import { buildWingetMatcher, buildChocolateyMatcher, resolveAltSources, type ChocolateyMatcher } from "../catalog/matching.js";
import { demoManualRemediations } from "./manual-remediations.js";
import { isSoftwareRecommendation, loadActiveExceptions, isExcepted } from "./recommendations.js";
import { loadExcludedDeviceIndex, exclusionReason } from "./device-exclusions.js";
import { demoSettings } from "./settings-store.js";
import { exposureByFinding, FINDING_KEY_SEP } from "../posture/exposure.js";
import { requirePermission } from "../auth/rbac.js";

// A branding.logoUrl uploaded as a data: URI, as text — bounds both the
// stored settings row and (doubled, for base64 overhead) the PUT route's
// bodyLimit override below. 2MB of source image is already generous for a
// logo; this is the encoded-string ceiling, so a touch under 2x that.
const LOGO_MAX_BYTES = 3_000_000;

/**
 * Read-only data routes.
 *
 * DEMO_MODE: served entirely from in-memory fixtures (no Postgres). Settings
 * edits mutate an in-memory copy so the Branding/SLA editors are still live.
 * Production: backed by Postgres (demo-seeded until Phase 2 wires live Graph).
 */
// Recommendation rows (per tenant) matched against a vuln's software name, to
// compute `relatedRecommendationId` — same either-contains match
// routes/recommendations.ts uses to join CVEs to recommendations.
export const relatedRecommendationIdFor = (
  tenantId: string,
  software: string,
  recRows: typeof demoRecommendations,
): string | null => {
  const target = normalizeTitle(software);
  if (!target) return null;
  for (const r of recRows) {
    if (r.tenantId !== tenantId || !isSoftwareRecommendation(r)) continue;
    const friendly = normalizeTitle(friendlyProductName(r.productName, r.vendor));
    if (friendly && (friendly === target || friendly.includes(target) || target.includes(friendly))) {
      return r.recommendationId;
    }
  }
  return null;
};

// Recomputes vulnerabilityCount/compliance per device, subtracting findings an
// active recommendation exception covers. Without this, excepting (say) OpenSSL
// makes its CVEs vanish from the device's "All CVEs" tab (filtered live by
// isExcepted, same as everywhere else) while the row/panel header keeps
// reporting the pre-exception count and "Noncompliant" — both frozen at sync
// time, since graph/sync.ts's compliance pass predates recommendation_exceptions
// and has no notion of it. Recomputing here keeps the two in agreement.
//
// Tenant-scoped, and only when the tenant actually has an active exception —
// the same guard every exception-driven adjustment in this file uses, and the
// reason a tenant-agnostic (all-tenants) request leaves the raw synced snapshot
// untouched, same as exceptions skip filtering everywhere else in that mode.
//
// Lives at module scope (rather than inside `dataRoutes`) and is exported so the
// posture snapshotter records the same post-exception device counts /api/devices
// serves. A second implementation there would drift, and the snapshot is meant to
// be the history of what the Dashboard actually showed.
export async function adjustForExceptions<
  T extends {
    defenderMachineId: string | null;
    deviceGroupId: string | null;
    vulnerabilityCount: number;
    compliance: "compliant" | "noncompliant" | "unknown";
  },
>(tenantId: string, devices: T[]): Promise<T[]> {
  const activeExceptions = await loadActiveExceptions(tenantId);
  if (activeExceptions.length === 0) return devices;

  const links = config.DEMO_MODE
    ? demoDeviceVulnerabilities.filter((dv) => dv.tenantId === tenantId)
    : await db
        .select()
        .from(tables.deviceVulnerabilities)
        .where(eq(tables.deviceVulnerabilities.tenantId, tenantId));
  if (links.length === 0) return devices;

  const linksByMachine = new Map<string, { cveId: string; software: string }[]>();
  for (const l of links) {
    const list = linksByMachine.get(l.defenderMachineId) ?? [];
    list.push({ cveId: l.cveId, software: l.software });
    linksByMachine.set(l.defenderMachineId, list);
  }

  const slaRow = config.DEMO_MODE
    ? undefined
    : await db.select().from(tables.settings).where(eq(tables.settings.key, "sla"));
  const thresholds = config.DEMO_MODE
    ? normalizeSlaThresholds(demoSettings.sla)
    : normalizeSlaThresholds(slaRow?.[0]?.value);

  const vulnRows = config.DEMO_MODE
    ? demoVulnerabilities.filter((v) => v.tenantId === tenantId)
    : await db.select().from(tables.vulnerabilities).where(eq(tables.vulnerabilities.tenantId, tenantId));
  const findingByPair = new Map<
    string,
    { severity: Severity; detectedAt: Date; exploitVerified: boolean }
  >();
  for (const v of vulnRows) {
    findingByPair.set(`${v.cveId}\x1f${v.software}`, {
      severity: v.severity as Severity,
      detectedAt: v.detectedAt,
      exploitVerified: v.exploitVerified,
    });
  }

  const recRows = config.DEMO_MODE
    ? demoRecommendations.filter((r) => r.tenantId === tenantId)
    : await db.select().from(tables.recommendations).where(eq(tables.recommendations.tenantId, tenantId));

  const now = new Date();
  return devices.map((d) => {
    if (!d.defenderMachineId) return d;
    const deviceLinks = linksByMachine.get(d.defenderMachineId);
    if (!deviceLinks || deviceLinks.length === 0) return d;

    let anyExcepted = false;
    const findings: { severity: Severity; detectedAt: Date; exploitVerified: boolean }[] = [];
    for (const l of deviceLinks) {
      const relatedRecommendationId = relatedRecommendationIdFor(tenantId, l.software, recRows);
      const excepted = isExcepted(activeExceptions, d.deviceGroupId, {
        cveId: l.cveId,
        recommendationIds: relatedRecommendationId ? [relatedRecommendationId] : [],
      });
      if (excepted) {
        anyExcepted = true;
        continue;
      }
      const finding = findingByPair.get(`${l.cveId}\x1f${l.software}`);
      if (finding) findings.push(finding);
    }
    if (!anyExcepted) return d;

    return {
      ...d,
      vulnerabilityCount: findings.length,
      compliance: deviceSlaCompliance(findings, thresholds, now),
    };
  });
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  // Require an authenticated engineer for all data routes. In DEMO_MODE the
  // server injects a demo engineer session (see server.ts), so this passes.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  // Per-device detection evidence (installed version + disk/registry paths), keyed
  // by the (cveId, software) pair — the grain a vuln row now lives at, since one
  // CVE can affect several products. Only supplied for the device drill-down; the
  // fleet-wide list omits it.
  type CveEvidence = {
    installedVersion: string | null;
    diskPaths: string[] | null;
    registryPaths: string[] | null;
  };
  // Same key the exposure count is grouped by — see posture/exposure.ts.
  const EVIDENCE_SEP = FINDING_KEY_SEP;

  // A remediation this device already applied, proven by the script's own output,
  // that Defender hasn't caught up with yet (its software inventory refreshes on a
  // 3-4 hour cadence Microsoft gives no way to force). Annotation only — the
  // finding below is still exactly what Defender reports.
  type FixedOnDevice = {
    packageId: string;
    versionBefore: string | null;
    versionAfter: string | null;
    verifiedAt: string;
  };

  /** How long a device-side fix keeps annotating a finding Defender still reports. */
  const FIXED_ON_DEVICE_WINDOW_MS = 24 * 3_600_000;

  // An engineer's "mark as manually remediated" record for this device+CVE —
  // "waiting on Defender" until the next sync stops reporting it (see
  // routes/manual-remediations.ts and graph/sync.ts's auto-confirmation).
  type ManuallyRemediated = {
    notes: string;
    engineer: string;
    markedAt: string;
    confirmedAt: string | null;
  };

  // Tenant-wide detection evidence for the fleet-wide vulnerabilities list: the
  // union of disk/registry paths (and distinct installed versions) Defender
  // reported across every device in the tenant for a given (cveId, software)
  // pair. Deliberately tenant-scoped — a cross-tenant key collision would leak
  // one customer's file layout into another's view — so callers with no
  // tenantId (the rare all-tenants request) skip this the same way they
  // already skip exception filtering below.
  async function loadFleetEvidence(
    tenantId: string,
    // Membership-only, so the caller can hand over `ExcludedDeviceIndex.byMachineId`
    // (a Map to the exclusion row) without rebuilding it as a Set.
    excludedMachineIds: { readonly size: number; has(machineId: string): boolean },
  ): Promise<{ evidence: Map<string, CveEvidence>; exposure: Map<string, number> }> {
    const all = config.DEMO_MODE
      ? demoDeviceVulnerabilities.filter((dv) => dv.tenantId === tenantId)
      : await db
          .select()
          .from(tables.deviceVulnerabilities)
          .where(eq(tables.deviceVulnerabilities.tenantId, tenantId));

    // An excluded device contributes neither evidence nor exposure — Defender's
    // excluded devices likewise stop contributing to every vulnerability page.
    // Dropping them here rather than at each consumer means one filter covers
    // the disk/registry paths, the installed-version list AND the count.
    const rows = excludedMachineIds.size
      ? all.filter((r) => !excludedMachineIds.has(r.defenderMachineId))
      : all;

    const versions = new Map<string, Set<string>>();
    const diskPaths = new Map<string, Set<string>>();
    const registryPaths = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = `${r.cveId}${EVIDENCE_SEP}${r.software}`;
      if (r.softwareVersion) {
        (versions.get(key) ?? versions.set(key, new Set()).get(key)!).add(r.softwareVersion);
      }
      for (const p of r.diskPaths ?? []) {
        (diskPaths.get(key) ?? diskPaths.set(key, new Set()).get(key)!).add(p);
      }
      for (const p of r.registryPaths ?? []) {
        (registryPaths.get(key) ?? registryPaths.set(key, new Set()).get(key)!).add(p);
      }
    }

    const keys = new Set([...versions.keys(), ...diskPaths.keys(), ...registryPaths.keys()]);
    const evidence = new Map<string, CveEvidence>();
    for (const key of keys) {
      const v = versions.get(key);
      const d = diskPaths.get(key);
      const r = registryPaths.get(key);
      evidence.set(key, {
        installedVersion: v && v.size > 0 ? [...v].join(", ") : null,
        diskPaths: d && d.size > 0 ? [...d] : null,
        registryPaths: r && r.size > 0 ? [...r] : null,
      });
    }

    // Distinct machines per (cveId, software) — the read-time replacement for
    // `vulnerabilities.affectedDeviceCount`, which is stamped at sync time and
    // therefore still counts excluded devices. Shared with the Dashboard's
    // posture pipeline so the two can never report different exposure.
    const exposure = exposureByFinding(rows);

    return { evidence, exposure };
  }

  /** Verifications are matched case-insensitively on winget id, else software title. */
  const fixKey = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

  const lookupFix = (
    fixes: Map<string, FixedOnDevice> | undefined,
    v: { wingetPackageId: string | null; software: string },
  ): FixedOnDevice | undefined => {
    if (!fixes) return undefined;
    const byPackage = v.wingetPackageId ? fixes.get(fixKey(v.wingetPackageId)) : undefined;
    return byPackage ?? fixes.get(fixKey(v.software));
  };

  const withSla = (
    rows: typeof demoVulnerabilities,
    thresholds: SlaThresholds,
    matcher: (tenantId: string, software: string) => { packageId: string } | null,
    evidence?: Map<string, CveEvidence>,
    fixes?: Map<string, FixedOnDevice>,
    manualByCve?: Map<string, ManuallyRemediated>,
    chocolateyMatcher?: ChocolateyMatcher | null,
  ) =>
    rows.map((v) => {
      const sla = computeSla(v.severity as Severity, v.detectedAt, thresholds, undefined, v.exploitVerified);
      const ev = evidence?.get(`${v.cveId}${EVIDENCE_SEP}${v.software}`);
      const fix = lookupFix(fixes, v);
      // If Defender is already reporting the version we installed, it has
      // refreshed and kept the finding anyway — the upgrade didn't clear it, so
      // saying "awaiting Defender" would be a lie. Drop the annotation.
      const defenderCaughtUp =
        fix?.versionAfter != null &&
        ev?.installedVersion != null &&
        ev.installedVersion === fix.versionAfter;
      // wingetRemediable/wingetPackageId on `v` are frozen at sync time and
      // over-report "out of winget scope" as the catalog/overrides evolve —
      // recompute live against the current catalog rather than trust them.
      const match = matcher(v.tenantId, v.software);
      // For a not-winget-remediable app, surface the alternate repos this
      // finding can still be driven through — live-matched against the
      // mirrored Chocolatey catalog, curated map as fallback (see
      // resolveAltSources). Empty for a winget-covered or OS finding.
      const altSources = match ? [] : resolveAltSources(chocolateyMatcher ?? null, v.tenantId, v.software);
      // Defender reports the software name verbatim from its catalog, so a
      // vendor-registered non-Latin name (e.g. Chinese) surfaces regardless of
      // the device's OS locale. Append a curated English hint where we have one;
      // the source name is preserved so it stays cross-referenceable.
      return {
        ...v,
        software: annotateForeignName(v.software),
        // Marketing-friendly name for display only (e.g. "Chromium" reads as
        // "Microsoft Edge (Chromium-based)" or "Google Chrome" depending on
        // disk-path evidence); the raw `software` above stays untouched since
        // it's still the join key for winget matching and the DB grain.
        displayName: resolveDisplaySoftwareName(v.software, ev?.diskPaths),
        sla: { ...sla, chip: slaChipLabel(sla) },
        installedVersion: ev?.installedVersion ?? null,
        diskPaths: ev?.diskPaths ?? null,
        registryPaths: ev?.registryPaths ?? null,
        fixedOnDevice: defenderCaughtUp ? null : (fix ?? null),
        manuallyRemediated: manualByCve?.get(v.cveId) ?? null,
        wingetRemediable: Boolean(match),
        wingetPackageId: match?.packageId ?? null,
        altSources,
      };
    });

  const withRelatedRecommendation = <T extends { tenantId: string; software: string }>(
    rows: T[],
    recRows: typeof demoRecommendations,
  ): (T & { relatedRecommendationId: string | null })[] =>
    rows.map((v) => ({
      ...v,
      relatedRecommendationId: relatedRecommendationIdFor(v.tenantId, v.software, recRows),
    }));

  app.get("/api/tenants", async () => {
    if (config.DEMO_MODE) return demoTenants;
    return db.select().from(tables.tenants);
  });

  // Three unrelated per-tenant settings share this one write path (the only
  // code path that touches any of these columns, same rationale for all:
  // an engineer opts in explicitly, sync never writes here):
  //   - `readOnly` — the write-actions opt-in. Flipping to write-enabled is what
  //     lets the preflight "write-actions" check pass and remediations dispatch;
  //     an engineer can flip it back to read-only at any time to re-freeze the
  //     tenant.
  //   - `featureUpdateTargetVersion` — the per-tenant feature-update target label
  //     (e.g. "24H2"); a customer's fleet may intentionally lag the latest
  //     release. `null` means "use the default" (`resolveTargetBuild()` falls
  //     back to the latest known build).
  //   - `liveResponseDeviceLimit` — this tenant's own slice of PatchPilot's
  //     instance-wide Live Response device pool (entitlement.deviceLicensePool
  //     — see packages/graph/src/entitlement.ts). The vendor controls the size
  //     of the pool; this MSP's own admin controls how it's divided across
  //     tenants, which is why this is a write here rather than something
  //     derived from the entitlement token itself. Rejected if it would push
  //     the sum of every tenant's allocation over the pool.
  // All three fields are independently optional (at least one required) and
  // audited as distinct actions since they're unrelated. Disabled in
  // DEMO_MODE, where tenants are fixtures and nothing is ever dispatched.
  app.patch<{
    Params: { tenantId: string };
    Body: {
      readOnly?: boolean;
      featureUpdateTargetVersion?: string | null;
      liveResponseDeviceLimit?: number;
    };
  }>(
    "/api/tenants/:tenantId",
    { preHandler: requirePermission("settings:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply
          .code(409)
          .send({ error: "tenant settings are read-only in demo mode" });
      }

      const { readOnly, featureUpdateTargetVersion, liveResponseDeviceLimit } = req.body ?? {};
      const settingReadOnly = typeof readOnly === "boolean";
      const settingFeatureUpdateTarget = featureUpdateTargetVersion !== undefined;
      const settingDeviceLimit = liveResponseDeviceLimit !== undefined;
      if (!settingReadOnly && !settingFeatureUpdateTarget && !settingDeviceLimit) {
        return reply.code(400).send({
          error:
            "readOnly (boolean), featureUpdateTargetVersion (string or null), and/or liveResponseDeviceLimit (integer) is required",
        });
      }
      if (
        settingFeatureUpdateTarget &&
        featureUpdateTargetVersion !== null &&
        !Object.values(CLIENT_BUILDS).includes(featureUpdateTargetVersion)
      ) {
        return reply.code(400).send({ error: `unknown target version: ${featureUpdateTargetVersion}` });
      }
      if (
        settingDeviceLimit &&
        (!Number.isInteger(liveResponseDeviceLimit) || liveResponseDeviceLimit! < 0)
      ) {
        return reply.code(400).send({ error: "liveResponseDeviceLimit must be a non-negative integer" });
      }

      const { tenantId } = req.params;

      if (settingDeviceLimit) {
        const effective = await resolveEffectiveEntitlement();
        const pool = effective.deviceLicensePool;
        const allTenants = await db
          .select({
            tenantId: tables.tenants.tenantId,
            liveResponseDeviceLimit: tables.tenants.liveResponseDeviceLimit,
          })
          .from(tables.tenants);
        const allocatedElsewhere = allTenants
          .filter((t) => t.tenantId !== tenantId)
          .reduce((sum, t) => sum + t.liveResponseDeviceLimit, 0);
        if (allocatedElsewhere + liveResponseDeviceLimit! > pool) {
          return reply.code(400).send({
            error: `This would allocate ${allocatedElsewhere + liveResponseDeviceLimit!} devices, but the license key's pool only covers ${pool}. ${allocatedElsewhere} ${allocatedElsewhere === 1 ? "is" : "are"} already allocated to other tenants.`,
          });
        }
      }

      const patch: {
        readOnly?: boolean;
        featureUpdateTargetVersion?: string | null;
        liveResponseDeviceLimit?: number;
      } = {};
      if (settingReadOnly) patch.readOnly = readOnly;
      if (settingFeatureUpdateTarget) patch.featureUpdateTargetVersion = featureUpdateTargetVersion;
      if (settingDeviceLimit) patch.liveResponseDeviceLimit = liveResponseDeviceLimit;

      const [updated] = await db
        .update(tables.tenants)
        .set(patch)
        .where(eq(tables.tenants.tenantId, tenantId))
        .returning();

      if (!updated) {
        return reply.code(404).send({ error: "tenant not found" });
      }

      const engineer = req.session.engineer!.upn;
      if (settingReadOnly) {
        await audit({
          engineer,
          tenantId,
          endpoint: `/api/tenants/${tenantId}`,
          method: "PATCH",
          action: "tenant:set-write-posture",
          resourceType: "tenant",
          resourceId: tenantId,
          resourceLabel: updated.displayName,
          summary: `Set ${updated.displayName} to ${readOnly ? "read-only" : "write-enabled"}`,
          outcome: "success",
          payload: { readOnly },
          responseStatus: 200,
        });
      }
      if (settingDeviceLimit) {
        await audit({
          engineer,
          tenantId,
          endpoint: `/api/tenants/${tenantId}`,
          method: "PATCH",
          action: "tenant:set-live-response-device-limit",
          resourceType: "tenant",
          resourceId: tenantId,
          resourceLabel: updated.displayName,
          summary: `Set ${updated.displayName}'s Live Response device allocation to ${liveResponseDeviceLimit}`,
          outcome: "success",
          payload: { liveResponseDeviceLimit },
          responseStatus: 200,
        });
      }
      if (settingFeatureUpdateTarget) {
        await audit({
          engineer,
          tenantId,
          endpoint: `/api/tenants/${tenantId}`,
          method: "PATCH",
          action: "tenant:set-feature-update-target",
          resourceType: "tenant",
          resourceId: tenantId,
          resourceLabel: updated.displayName,
          summary: `Set ${updated.displayName}'s feature update target to ${featureUpdateTargetVersion ?? "default (latest)"}`,
          outcome: "success",
          payload: { featureUpdateTargetVersion },
          responseStatus: 200,
        });
      }

      return updated;
    },
  );

  // Annotate-then-filter, the same convention `includeExceptions` follows on the
  // findings routes: every row carries `excluded`, and excluded rows are dropped
  // unless the caller opts in. Defender does the same thing — an excluded device
  // stays in the device inventory, behind an "Exclusion state" filter, and
  // disappears from everywhere else.
  //
  // Unlike exceptions, this still applies when no tenantId is given. The Devices
  // page is routinely viewed in all-tenants mode, and "excluded everywhere except
  // the one list you actually look at" would be worse than not having the feature.
  app.get<{ Querystring: { tenantId?: string; includeExcluded?: string } }>(
    "/api/devices",
    async (req) => {
      const tenantId = req.query.tenantId;
      const includeExcluded = req.query.includeExcluded === "true";
      const rows = config.DEMO_MODE ? demoDevices : await db.select().from(tables.devices);
      const scoped = tenantId ? rows.filter((d) => d.tenantId === tenantId) : rows;

      const index = await loadExcludedDeviceIndex(tenantId);
      const annotated = scoped.map((d) => {
        const e = index.byManagedDeviceId.get(d.managedDeviceId);
        // Guard the all-tenants load — never hide one customer's device because
        // another customer excluded an id that happened to match.
        const live = e && e.tenantId === d.tenantId ? e : undefined;
        return {
          ...d,
          excluded: Boolean(live),
          exclusionReason: live ? exclusionReason(live) : null,
          // The full row, so the detail panel can show justification, note, who
          // and when without a second round trip — and so "Stop exclusion" has
          // an id to post to.
          exclusion: live ?? null,
        };
      });

      const adjusted = tenantId ? await adjustForExceptions(tenantId, annotated) : annotated;

      return includeExcluded ? adjusted : adjusted.filter((d) => !d.excluded);
    },
  );

  app.get<{ Querystring: { tenantId?: string; includeExceptions?: string } }>(
    "/api/vulnerabilities",
    async (req) => {
      const matcher = await buildWingetMatcher();
      const chocolateyMatcher = await buildChocolateyMatcher();
      const tenantId = req.query.tenantId;
      const includeExceptions = req.query.includeExceptions === "true";

      const excludedIndex = await loadExcludedDeviceIndex(tenantId);
      // Tenant-wide evidence (see loadFleetEvidence) only resolves for a
      // single tenant — the all-tenants view carries none, same as exceptions.
      const fleet = tenantId
        ? await loadFleetEvidence(tenantId, excludedIndex.byMachineId)
        : undefined;

      async function loadRows() {
        const evidence = fleet?.evidence;

        if (config.DEMO_MODE) {
          const thresholds = normalizeSlaThresholds(demoSettings.sla);
          const rows = tenantId
            ? demoVulnerabilities.filter((v) => v.tenantId === tenantId)
            : demoVulnerabilities;
          const recRows = tenantId
            ? demoRecommendations.filter((r) => r.tenantId === tenantId)
            : demoRecommendations;
          return withRelatedRecommendation(
            withSla(rows, thresholds, matcher, evidence, undefined, undefined, chocolateyMatcher),
            recRows,
          );
        }

        const slaRow = await db
          .select()
          .from(tables.settings)
          .where(eq(tables.settings.key, "sla"));
        const thresholds = normalizeSlaThresholds(slaRow[0]?.value);

        const rows = await db.select().from(tables.vulnerabilities);
        const filtered = tenantId ? rows.filter((v) => v.tenantId === tenantId) : rows;
        const recRows = await db.select().from(tables.recommendations);
        const filteredRecRows = tenantId ? recRows.filter((r) => r.tenantId === tenantId) : recRows;
        return withRelatedRecommendation(
          withSla(filtered, thresholds, matcher, evidence, undefined, undefined, chocolateyMatcher),
          filteredRecRows,
        );
      }
      const loaded = await loadRows();

      // `vulnerabilities.affectedDeviceCount` is stamped at sync time and still
      // counts excluded devices, so recompute it from the device⇄CVE join and
      // drop findings whose entire exposure was excluded.
      //
      // Only when something is actually excluded. Recomputing unconditionally
      // would replace Defender's own count with one derived from
      // `device_vulnerabilities`, which is sparser for tenants on the lighter
      // machinesVulnerabilities fallback — that would silently hide real
      // findings on tenants using no exclusions at all.
      const result =
        fleet && !excludedIndex.isEmpty
          ? loaded
              .map((v) => ({
                ...v,
                affectedDeviceCount: fleet.exposure.get(`${v.cveId}${EVIDENCE_SEP}${v.software}`) ?? 0,
              }))
              .filter((v) => v.affectedDeviceCount > 0)
          : loaded;

      // Exceptions are tenant-scoped, hidden-by-default; a tenant-agnostic
      // (no tenantId) request can't resolve them, so it skips filtering.
      if (!tenantId) return result.map((v) => ({ ...v, exception: false }));

      const activeExceptions = await loadActiveExceptions(tenantId);
      const annotated = result.map((v) => ({
        ...v,
        exception: isExcepted(activeExceptions, null, {
          cveId: v.cveId,
          recommendationIds: v.relatedRecommendationId ? [v.relatedRecommendationId] : [],
        }),
      }));
      return includeExceptions ? annotated : annotated.filter((v) => !v.exception);
    },
  );

  // Per-device CVE exposure: the same vulnerability rows as /api/vulnerabilities,
  // filtered to one device via the persisted device⇄CVE linkage. Powers the
  // device detail panel's severity pills + CVE table. A device with no Defender
  // machine id (Intune-only) has no linkage and returns an empty list.
  app.get<{ Params: { id: string }; Querystring: { includeExceptions?: string } }>(
    "/api/devices/:id/vulnerabilities",
    async (req, reply) => {
      const deviceId = req.params.id;
      const matcher = await buildWingetMatcher();
      const chocolateyMatcher = await buildChocolateyMatcher();
      const includeExceptions = req.query.includeExceptions === "true";

      // Defender's stated behaviour on the device page for an excluded device:
      // no discovered vulnerabilities, no software inventory, no security
      // recommendations. The panel renders an explanatory empty state off the
      // device row's own `excluded` flag, so an empty array is all this owes it.
      if ((await loadExcludedDeviceIndex()).byDeviceId.has(deviceId)) return [];

      if (config.DEMO_MODE) {
        const device = demoDevices.find((d) => d.id === deviceId);
        if (!device) return reply.code(404).send({ error: "not_found" });
        if (!device.defenderMachineId) return [];
        const thresholds = normalizeSlaThresholds(demoSettings.sla);
        const deviceLinks = demoDeviceVulnerabilities.filter(
          (dv) =>
            dv.tenantId === device.tenantId &&
            dv.defenderMachineId === device.defenderMachineId,
        );
        // Key linkage + evidence by (cveId, software): a device can be exposed to
        // one CVE via two different products, and each is a distinct finding row.
        const linkKeys = new Set(
          deviceLinks.map((dv) => `${dv.cveId}\x1f${dv.software}`),
        );
        const evidence = new Map(
          deviceLinks.map((dv) => [
            `${dv.cveId}\x1f${dv.software}`,
            {
              installedVersion: dv.softwareVersion,
              diskPaths: dv.diskPaths,
              registryPaths: dv.registryPaths,
            },
          ]),
        );
        const rows = demoVulnerabilities.filter(
          (v) =>
            v.tenantId === device.tenantId &&
            linkKeys.has(`${v.cveId}\x1f${v.software}`),
        );
        // Newest wins: rows already come back sorted, but sort explicitly by
        // markedAt so a device with several records for the same CVE picks
        // the latest one.
        const manualByCve = new Map<string, ManuallyRemediated>();
        for (const r of [...demoManualRemediations].sort((a, b) =>
          b.markedAt.localeCompare(a.markedAt),
        )) {
          if (r.tenantId !== device.tenantId || r.deviceId !== device.id) continue;
          if (r.cveId && !manualByCve.has(r.cveId)) {
            manualByCve.set(r.cveId, {
              notes: r.notes,
              engineer: r.engineer,
              markedAt: r.markedAt,
              confirmedAt: r.confirmedAt,
            });
          }
        }
        const recRows = demoRecommendations.filter((r) => r.tenantId === device.tenantId);
        const shaped = withRelatedRecommendation(
          withSla(rows, thresholds, matcher, evidence, undefined, manualByCve, chocolateyMatcher),
          recRows,
        );
        const activeExceptions = await loadActiveExceptions(device.tenantId);
        const annotated = shaped.map((v) => ({
          ...v,
          exception: isExcepted(activeExceptions, device.deviceGroupId, {
            cveId: v.cveId,
            recommendationIds: v.relatedRecommendationId ? [v.relatedRecommendationId] : [],
          }),
        }));
        return includeExceptions ? annotated : annotated.filter((v) => !v.exception);
      }

      const deviceRows = await db
        .select()
        .from(tables.devices)
        .where(eq(tables.devices.id, deviceId));
      const device = deviceRows[0];
      if (!device) return reply.code(404).send({ error: "not_found" });
      if (!device.defenderMachineId) return [];

      const slaRow = await db
        .select()
        .from(tables.settings)
        .where(eq(tables.settings.key, "sla"));
      const thresholds = normalizeSlaThresholds(slaRow[0]?.value);

      const links = await db
        .select({
          cveId: tables.deviceVulnerabilities.cveId,
          software: tables.deviceVulnerabilities.software,
          softwareVersion: tables.deviceVulnerabilities.softwareVersion,
          diskPaths: tables.deviceVulnerabilities.diskPaths,
          registryPaths: tables.deviceVulnerabilities.registryPaths,
        })
        .from(tables.deviceVulnerabilities)
        .where(
          and(
            eq(tables.deviceVulnerabilities.tenantId, device.tenantId),
            eq(tables.deviceVulnerabilities.defenderMachineId, device.defenderMachineId),
          ),
        );
      // Key by (cveId, software): a device can be exposed to one CVE via two
      // different products, and each is a distinct finding row.
      const linkKeys = new Set(links.map((l) => `${l.cveId}\x1f${l.software}`));
      if (linkKeys.size === 0) return [];
      const evidence = new Map(
        links.map((l) => [
          `${l.cveId}\x1f${l.software}`,
          {
            installedVersion: l.softwareVersion,
            diskPaths: l.diskPaths,
            registryPaths: l.registryPaths,
          },
        ]),
      );

      // Remediations this device already applied that Defender may not have
      // published yet. Bounded to a day: past that, a finding still standing is
      // no longer "awaiting a refresh" — Defender has had several cadences to
      // clear it and hasn't, so the honest thing is to show it untouched again.
      const fixedSince = new Date(Date.now() - FIXED_ON_DEVICE_WINDOW_MS);
      const verifications = await db
        .select()
        .from(tables.remediationVerifications)
        .where(
          and(
            eq(tables.remediationVerifications.tenantId, device.tenantId),
            eq(tables.remediationVerifications.deviceId, device.id),
            gte(tables.remediationVerifications.verifiedAt, fixedSince),
          ),
        )
        .orderBy(desc(tables.remediationVerifications.verifiedAt));
      // Newest wins: rows arrive newest-first, so only insert a key once.
      const fixes = new Map<string, FixedOnDevice>();
      for (const r of verifications) {
        const fix: FixedOnDevice = {
          packageId: r.packageId,
          versionBefore: r.versionBefore,
          versionAfter: r.versionAfter,
          verifiedAt: r.verifiedAt.toISOString(),
        };
        for (const key of [fixKey(r.packageId), fixKey(r.software)]) {
          if (key && !fixes.has(key)) fixes.set(key, fix);
        }
      }

      // "Marked as manually remediated" records for this device — "waiting on
      // Defender" until the auto-confirmation in graph/sync.ts stamps
      // confirmedAt. No time bound (unlike fixedOnDevice above): an engineer's
      // manual note stays valid until Defender explicitly confirms it, however
      // long that takes.
      const manualRows = await db
        .select()
        .from(tables.manualRemediations)
        .where(
          and(
            eq(tables.manualRemediations.tenantId, device.tenantId),
            eq(tables.manualRemediations.deviceId, device.id),
          ),
        )
        .orderBy(desc(tables.manualRemediations.markedAt));
      const manualByCve = new Map<string, ManuallyRemediated>();
      for (const r of manualRows) {
        if (r.cveId && !manualByCve.has(r.cveId)) {
          manualByCve.set(r.cveId, {
            notes: r.notes,
            engineer: r.engineer,
            markedAt: r.markedAt.toISOString(),
            confirmedAt: r.confirmedAt ? r.confirmedAt.toISOString() : null,
          });
        }
      }

      const vulnRows = await db
        .select()
        .from(tables.vulnerabilities)
        .where(eq(tables.vulnerabilities.tenantId, device.tenantId));
      const recRows = await db
        .select()
        .from(tables.recommendations)
        .where(eq(tables.recommendations.tenantId, device.tenantId));
      const shaped = withRelatedRecommendation(
        withSla(
          vulnRows.filter((v) => linkKeys.has(`${v.cveId}\x1f${v.software}`)),
          thresholds,
          matcher,
          evidence,
          fixes,
          manualByCve,
          chocolateyMatcher,
        ),
        recRows,
      );
      const activeExceptions = await loadActiveExceptions(device.tenantId);
      const annotated = shaped.map((v) => ({
        ...v,
        exception: isExcepted(activeExceptions, device.deviceGroupId, {
          cveId: v.cveId,
          recommendationIds: v.relatedRecommendationId ? [v.relatedRecommendationId] : [],
        }),
      }));
      return includeExceptions ? annotated : annotated.filter((v) => !v.exception);
    },
  );

  // Settings: branding + SLA thresholds (ported from prototype).
  app.get("/api/settings/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    if (config.DEMO_MODE) {
      const value = demoSettings[key];
      if (!value) return reply.code(404).send({ error: "not_found" });
      return value;
    }
    const row = await db.select().from(tables.settings).where(eq(tables.settings.key, key));
    if (!row[0]) return reply.code(404).send({ error: "not_found" });
    return row[0].value;
  });

  app.put(
    "/api/settings/:key",
    {
      preHandler: requirePermission("settings:write"),
      // A logo saved as a data: URI easily clears the framework's 1MB
      // default — the client already caps the source file at LOGO_MAX_BYTES
      // (routes/data.ts export below), so this just needs headroom for the
      // ~33% base64 blow-up plus the rest of the branding JSON.
      bodyLimit: LOGO_MAX_BYTES * 2,
    },
    async (req, reply) => {
    const { key } = req.params as { key: string };
    const value = req.body as Record<string, unknown>;
    if (key === "branding") {
      // Product name is fixed, not white-label config — see
      // apps/web/src/lib/branding.ts for why. Enforced here too so a direct
      // API call can't rename it even though the UI no longer offers a field
      // for it.
      value.productName = "PatchPilot365";
      if (typeof value.logoUrl === "string" && value.logoUrl.length > LOGO_MAX_BYTES) {
        return reply.code(400).send({ error: "logo_too_large" });
      }
    }
    if (config.DEMO_MODE) {
      demoSettings[key] = value;
    } else {
      await db
        .insert(tables.settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: tables.settings.key, set: { value, updatedAt: new Date() } });
    }

    // Settings are global (SLA thresholds, branding), so no tenantId. The new
    // value is hashed like any other payload rather than stored — what changed
    // is readable from the setting itself; that it changed, and by whom, is not.
    await audit({
      engineer: req.session.engineer!.upn,
      endpoint: `/api/settings/${key}`,
      method: "PUT",
      action: "setting:update",
      resourceType: "setting",
      resourceId: key,
      resourceLabel: key,
      summary: `Updated the "${key}" settings`,
      outcome: "success",
      payload: value,
      responseStatus: 200,
    });

    return { ok: true };
    },
  );
}
