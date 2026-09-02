import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  tables,
  demoDevices,
  demoDeviceVulnerabilities,
  demoRecommendations,
  demoRecommendationExceptions,
  type RecommendationExceptionRow,
} from "@patchpilot/db";
import {
  computeSla,
  slaChipLabel,
  friendlyProductName,
  prettifySoftwareTitle,
  normalizeTitle,
  resolveMatchingTitle,
  detectInstallScope,
  normalizeSlaThresholds,
  type SlaThresholds,
  type Severity,
  type InstallScope,
} from "@patchpilot/shared";
import { audit } from "@patchpilot/graph";
import { fetchExposedDevices, buildMachineEvidence } from "../graph/sync.js";
import { config } from "../config.js";
import { demoSettings } from "./settings-store.js";
import { loadExcludedDeviceIndex, type ExcludedDeviceIndex } from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Security Recommendations routes — Defender's TVM "Recommendations" feed,
 * surfaced 1:1 the way the Defender portal's own Recommendations page shows it.
 * Extracted out of routes/data.ts so Security Recommendations is a first-class
 * surface (its own nav section + Devices tab) instead of a view toggle buried
 * inside Vulnerabilities.
 */

/**
 * The configured SLA thresholds, or the defaults when Settings has never been
 * saved. Exported because the posture snapshotter has to freeze the exact
 * thresholds a route would have used at capture time — if it re-derived them,
 * a later Settings change would silently rewrite history.
 */
export async function loadSlaThresholds(): Promise<SlaThresholds> {
  if (config.DEMO_MODE) {
    return normalizeSlaThresholds(demoSettings.sla);
  }
  const slaRow = await db.select().from(tables.settings).where(eq(tables.settings.key, "sla"));
  return normalizeSlaThresholds(slaRow[0]?.value);
}

// Defender's /recommendations feed is ALREADY one actionable row per product —
// "Update Google Chrome to version 151.0.7922.71" — which is exactly what the
// portal's Recommendations page lists. PatchPilot passes those rows straight
// through (no regrouping: an extra group-by product name only ever *split* rows
// when Defender's vendor token drifted) and shows Defender's own
// `recommendationName` as the row title.
//
// The portal splits the same feed across two tables — Vulnerabilities (software
// and OS updates) and Misconfigurations (security controls, accounts, network) —
// so we classify each row the same way and let the caller pick.

export type RecommendationKind = "vulnerability" | "misconfiguration";

/** Which of the portal's two Recommendations tables a row belongs in. */
export const recommendationKind = (
  r: (typeof demoRecommendations)[number],
): RecommendationKind => {
  const remediation = (r.remediationType ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (remediation === "configurationchange") return "misconfiguration";
  const category = (r.category ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (category === "securitycontrols" || category === "accounts" || category === "network") {
    return "misconfiguration";
  }
  return "vulnerability";
};

/** True for software/OS update recommendations; false for misconfigurations. */
export const isSoftwareRecommendation = (
  r: (typeof demoRecommendations)[number],
): boolean => recommendationKind(r) === "vulnerability";

/**
 * Defender's own state for the row. Non-Active recommendations are now ingested
 * (see syncRecommendations) so a portal-side exception is visible rather than
 * silently missing — but they're filtered out of the default view here, the same
 * way local exceptions are.
 */
export const isDefenderActive = (r: (typeof demoRecommendations)[number]): boolean =>
  !r.recommendationStatus || r.recommendationStatus.toLowerCase() === "active";

// Install-scope evidence (disk/registry paths), bucketed per tenant and
// normalized software title, so a recommendation group ("Google Chrome")
// can be matched against the many raw `software` strings Defender reports
// devices under ("chrome", "Google Chrome (64-bit)", ...) the same way
// /api/recommendations/exposed-devices matches CVEs to recommendations.
type ScopeEvidence = { diskPaths: string[]; registryPaths: string[] };
type ScopeIndex = Map<string, Map<string, ScopeEvidence>>;

function buildScopeIndex(
  rows: { tenantId: string; software: string; diskPaths: string[] | null; registryPaths: string[] | null }[],
): ScopeIndex {
  const index: ScopeIndex = new Map();
  for (const r of rows) {
    if (!r.diskPaths?.length && !r.registryPaths?.length) continue;
    const norm = normalizeTitle(r.software);
    if (!norm) continue;
    let tenantMap = index.get(r.tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      index.set(r.tenantId, tenantMap);
    }
    let ev = tenantMap.get(norm);
    if (!ev) {
      ev = { diskPaths: [], registryPaths: [] };
      tenantMap.set(norm, ev);
    }
    if (r.diskPaths) ev.diskPaths.push(...r.diskPaths);
    if (r.registryPaths) ev.registryPaths.push(...r.registryPaths);
  }
  return index;
}

/** Raw evidence backing a recommendation's aggregated installScope. */
type FriendlyEvidence = { installScope: InstallScope; diskPaths: string[]; registryPaths: string[] };

// Aggregates evidence from every raw software title that either-contains
// matches the group's friendly name, then classifies once — "machine" wins
// over "user" whenever both appear, matching detectInstallScope's rule. Also
// returns the deduped raw paths behind that classification, so the UI can
// show "how it was detected" alongside the derived Context chip.
function scopeForFriendly(index: ScopeIndex, tenantId: string, friendly: string): FriendlyEvidence {
  const tenantMap = index.get(tenantId);
  const target = normalizeTitle(friendly);
  if (!tenantMap || !target) return { installScope: "unknown", diskPaths: [], registryPaths: [] };
  const diskPaths: string[] = [];
  const registryPaths: string[] = [];
  for (const [sw, ev] of tenantMap) {
    if (sw === target || sw.includes(target) || target.includes(sw)) {
      diskPaths.push(...ev.diskPaths);
      registryPaths.push(...ev.registryPaths);
    }
  }
  const dedupedDiskPaths = [...new Set(diskPaths)];
  const dedupedRegistryPaths = [...new Set(registryPaths)];
  return {
    installScope: detectInstallScope(
      dedupedDiskPaths.length ? dedupedDiskPaths : null,
      dedupedRegistryPaths.length ? dedupedRegistryPaths : null,
    ),
    diskPaths: dedupedDiskPaths,
    registryPaths: dedupedRegistryPaths,
  };
}

/**
 * One shaped row per Defender recommendation — a pass-through, not a group-by.
 *
 * `recommendationName` is Defender's verbatim title and is what the UI shows as
 * the row identity. `productName`/`vendor` are still normalised to their friendly
 * forms because they're what every product-name match in this file keys off
 * (`matchesDeviceSoftware`, `scopeForFriendly`, data.ts's relatedRecommendationId)
 * — only the display precedence changed, not the matching.
 *
 * Update recommendations carry the same severity + detectedAt SLA clock as CVEs,
 * so they get the same on-track / due-soon / overdue chip. Misconfigurations have
 * no patch to ship and therefore no SLA clock — `sla` is null for those.
 */
function shapeRecommendations(
  rows: typeof demoRecommendations,
  thresholds: SlaThresholds,
  scopeIndex: ScopeIndex,
) {
  const shaped = rows.map((r) => {
    const kind = recommendationKind(r);
    const friendly = friendlyProductName(resolveMatchingTitle(r.productName), r.vendor);
    const sla =
      kind === "vulnerability"
        ? (() => {
            const s = computeSla(r.severity as Severity, r.detectedAt, thresholds);
            return { ...s, chip: slaChipLabel(s) };
          })()
        : null;
    const evidence: FriendlyEvidence =
      kind === "vulnerability"
        ? scopeForFriendly(scopeIndex, r.tenantId, friendly)
        : { installScope: "unknown", diskPaths: [], registryPaths: [] };
    return {
      ...r,
      kind,
      // Show the marketing name ("Google Chrome", not "chrome") and a tidy vendor.
      productName: friendly,
      // Defender fills `relatedComponent` with its own bare inventory title, and
      // the page prefers it over productName — so without the same alias the
      // Related component column still reads "Chrome" while everywhere else
      // reads "Google Chrome". Alias-only (never the ambiguous Chromium branch),
      // since a component label carries no disk-path evidence to disambiguate.
      relatedComponent: r.relatedComponent ? resolveMatchingTitle(r.relatedComponent) : r.relatedComponent,
      vendor: r.vendor ? prettifySoftwareTitle(r.vendor) : r.vendor,
      // Kept as an array so every consumer built against the old consolidated
      // shape (isExcepted, the exposed-devices query param, the deep-link match)
      // keeps working unchanged — it's simply always length 1 now.
      recommendationIds: [r.recommendationId],
      sla,
      installScope: evidence.installScope,
      diskPaths: evidence.diskPaths,
      registryPaths: evidence.registryPaths,
    };
  });

  // Sensible default order: worst severity first, then most-exposed.
  shaped.sort(
    (a, b) =>
      (b.severityScore ?? -1) - (a.severityScore ?? -1) ||
      b.exposedMachinesCount - a.exposedMachinesCount,
  );
  return shaped;
}

// True when a consolidated recommendation's friendly product name matches one
// of a device's raw exposed software titles — the same normalized
// either-contains match used to join CVEs to recommendations elsewhere.
function matchesDeviceSoftware(productName: string, deviceSoftware: Set<string>): boolean {
  const target = normalizeTitle(productName);
  if (!target) return false;
  for (const sw of deviceSoftware) {
    if (sw === target || sw.includes(target) || target.includes(sw)) return true;
  }
  return false;
}

// ---- excluded-device exposure adjustment ----
// An excluded device must stop inflating a recommendation's "X of Y devices".
//
// The adjustment is a **subtraction, never a recomputation**. `exposedMachinesCount`
// is Defender's own number, and `device_vulnerabilities` is a sparser local view of
// the same fleet (tenants on the lighter machinesVulnerabilities fallback have far
// fewer rows than Defender counted), so replacing the number outright would silently
// shrink real findings. Every excluded machine we can attribute to a product *is*
// one of the machines Defender counted, so subtracting them gives a lower bound that
// is never wrong in the other direction. Same reasoning as the affectedDeviceCount
// recomputation in data.ts, and like that one it only runs when the tenant actually
// has an exclusion.
//
// Keyed per tenant for the same reason buildScopeIndex is: a normalized software
// title is not unique across tenants, so a flat map would let one tenant's excluded
// machine cancel out another tenant's exposure in the all-tenants view.
type ExcludedExposureIndex = Map<string, Map<string, Set<string>>>;

function buildExcludedExposureIndex(
  rows: { tenantId: string; software: string; defenderMachineId: string }[],
  excluded: ExcludedDeviceIndex,
): ExcludedExposureIndex {
  const index: ExcludedExposureIndex = new Map();
  if (excluded.isEmpty) return index;
  for (const r of rows) {
    if (!excluded.byMachineId.has(r.defenderMachineId)) continue;
    const sw = normalizeTitle(r.software);
    if (!sw) continue;
    let tenantMap = index.get(r.tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      index.set(r.tenantId, tenantMap);
    }
    let machines = tenantMap.get(sw);
    if (!machines) {
      machines = new Set();
      tenantMap.set(sw, machines);
    }
    machines.add(r.defenderMachineId);
  }
  return index;
}

// Distinct excluded machines exposed to a product, via the same normalized
// either-contains match scopeForFriendly and the exposed-devices route use.
function excludedExposureCount(
  index: ExcludedExposureIndex,
  tenantId: string,
  productName: string,
): number {
  const tenantMap = index.get(tenantId);
  const target = normalizeTitle(productName);
  if (!tenantMap || !target) return 0;
  const machines = new Set<string>();
  for (const [sw, ids] of tenantMap) {
    if (sw === target || sw.includes(target) || target.includes(sw)) {
      for (const id of ids) machines.add(id);
    }
  }
  return machines.size;
}

/** Excluded devices that are still in the fleet, per tenant — the `Y` side of "X of Y". */
function excludedFleetCounts(excluded: ExcludedDeviceIndex): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of excluded.byDeviceId.values()) {
    counts.set(e.tenantId, (counts.get(e.tenantId) ?? 0) + 1);
  }
  return counts;
}

type ExposureShaped = {
  tenantId: string;
  kind: RecommendationKind;
  productName: string;
  exposedMachinesCount: number;
  totalMachineCount: number;
};

/**
 * Applies the subtraction above and drops rows whose exposure reaches zero —
 * every machine that was exposed is now excluded, so the recommendation has
 * nothing left to act on.
 *
 * Misconfigurations are left alone on the exposed axis: they are tenant-wide
 * control findings with no product to match devices against (which is exactly why
 * the device tab shows every one of them for every device), so there is no honest
 * way to attribute one to a specific excluded machine. Only the fleet total moves,
 * with the exposed count clamped so it can never exceed it.
 */
function adjustForExcludedDevices<T extends ExposureShaped>(
  shaped: T[],
  exposure: ExcludedExposureIndex,
  fleetCounts: Map<string, number>,
): T[] {
  const adjusted: T[] = [];
  for (const r of shaped) {
    const excludedFleet = fleetCounts.get(r.tenantId) ?? 0;
    const totalMachineCount = Math.max(0, r.totalMachineCount - excludedFleet);
    if (r.kind === "misconfiguration") {
      adjusted.push({
        ...r,
        totalMachineCount,
        exposedMachinesCount: Math.min(r.exposedMachinesCount, totalMachineCount),
      });
      continue;
    }
    const exposedMachinesCount =
      r.exposedMachinesCount - excludedExposureCount(exposure, r.tenantId, r.productName);
    if (r.exposedMachinesCount > 0 && exposedMachinesCount <= 0) continue;
    adjusted.push({
      ...r,
      exposedMachinesCount: Math.max(0, exposedMachinesCount),
      totalMachineCount: Math.max(totalMachineCount, Math.max(0, exposedMachinesCount)),
    });
  }
  return adjusted;
}

// Local-only exception tracking: Defender has no public write API for
// exceptions ("Exceptions are currently only supported in the Microsoft
// Defender portal, and not via public API." — MS Learn), so PatchPilot
// records the engineer's intent here and uses it to filter its own views.
// The engineer still applies the matching exception by hand in the portal.
export const EXCEPTION_JUSTIFICATIONS = [
  "third-party-control",
  "alternate-mitigation",
  "risk-accepted",
  "planned-remediation",
  "cve-no-patch",
  "false-positive",
] as const;

const isExceptionLive = (e: RecommendationExceptionRow): boolean =>
  e.status === "active" && e.expiresAt.getTime() > Date.now();

/** What an exception covers, for the audit log's resource label. */
const exceptionLabel = (e: RecommendationExceptionRow): string =>
  e.recommendationId ?? e.cveId ?? "unspecified finding";

/** Every active, non-expired exception for a tenant. */
export async function loadActiveExceptions(tenantId: string): Promise<RecommendationExceptionRow[]> {
  const rows = config.DEMO_MODE
    ? demoRecommendationExceptions.filter((e) => e.tenantId === tenantId)
    : await db
        .select()
        .from(tables.recommendationExceptions)
        .where(eq(tables.recommendationExceptions.tenantId, tenantId));
  return rows.filter(isExceptionLive);
}

// True when `target` (a CVE id, or one of a consolidated recommendation's raw
// Defender ids) is covered by an active exception in scope. Global exceptions
// apply everywhere; device-group exceptions only apply when `deviceGroupId`
// (null for tenant-wide views, where only global exceptions can match) is one
// of the exception's group ids.
export function isExcepted(
  exceptions: RecommendationExceptionRow[],
  deviceGroupId: string | null,
  target: { recommendationIds?: string[]; cveId?: string },
): boolean {
  for (const e of exceptions) {
    if (e.scope === "device-group") {
      if (!deviceGroupId || !e.deviceGroupIds.includes(deviceGroupId)) continue;
    }
    if (e.cveId && target.cveId && e.cveId === target.cveId) return true;
    if (e.recommendationId && target.recommendationIds?.includes(e.recommendationId)) return true;
  }
  return false;
}

export async function recommendationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  // Defender's security recommendations, 1:1 with the portal's Recommendations
  // page. `kind` picks between the portal's two tables (Vulnerabilities /
  // Misconfigurations); omitted returns both, which is what the Devices page's
  // single merged tab wants.
  app.get<{
    Querystring: { tenantId?: string; includeExceptions?: string; kind?: RecommendationKind };
  }>(
    "/api/recommendations",
    async (req) => {
      const thresholds = await loadSlaThresholds();
      const tenantId = req.query.tenantId;
      const includeExceptions = req.query.includeExceptions === "true";
      const kind = req.query.kind;

      // Loaded across all tenants when the page is in all-tenants mode — excluded
      // devices are the one thing that must not reappear there (see
      // loadActiveExclusions). The exposure index below is tenant-keyed, so a
      // wider load never leaks one tenant's machines into another's counts.
      const excludedIndex = await loadExcludedDeviceIndex(tenantId);

      let shaped: ReturnType<typeof shapeRecommendations>;
      let exposureIndex: ExcludedExposureIndex;
      if (config.DEMO_MODE) {
        const rows = tenantId
          ? demoRecommendations.filter((r) => r.tenantId === tenantId)
          : demoRecommendations;
        const scopeRows = tenantId
          ? demoDeviceVulnerabilities.filter((dv) => dv.tenantId === tenantId)
          : demoDeviceVulnerabilities;
        shaped = shapeRecommendations(rows, thresholds, buildScopeIndex(scopeRows));
        exposureIndex = buildExcludedExposureIndex(scopeRows, excludedIndex);
      } else {
        const rows = await db.select().from(tables.recommendations);
        const filtered = tenantId ? rows.filter((r) => r.tenantId === tenantId) : rows;

        const scopeRows = await db
          .select({
            tenantId: tables.deviceVulnerabilities.tenantId,
            software: tables.deviceVulnerabilities.software,
            defenderMachineId: tables.deviceVulnerabilities.defenderMachineId,
            diskPaths: tables.deviceVulnerabilities.diskPaths,
            registryPaths: tables.deviceVulnerabilities.registryPaths,
          })
          .from(tables.deviceVulnerabilities);
        const filteredScopeRows = tenantId
          ? scopeRows.filter((sr) => sr.tenantId === tenantId)
          : scopeRows;
        shaped = shapeRecommendations(filtered, thresholds, buildScopeIndex(filteredScopeRows));
        exposureIndex = buildExcludedExposureIndex(filteredScopeRows, excludedIndex);
      }

      if (kind) shaped = shaped.filter((r) => r.kind === kind);

      if (!excludedIndex.isEmpty) {
        shaped = adjustForExcludedDevices(shaped, exposureIndex, excludedFleetCounts(excludedIndex));
      }

      // Exceptions are tenant-scoped, hidden-by-default; a tenant-agnostic
      // (no tenantId) request can't resolve them, so it skips filtering.
      if (!tenantId) {
        return shaped
          .filter((r) => isDefenderActive(r))
          .map((r) => ({ ...r, exception: false }));
      }

      const activeExceptions = await loadActiveExceptions(tenantId);
      // A row is "excepted" if either PatchPilot has a local exception for it or
      // Defender itself reports it as non-Active (portal-side exception/resolved).
      const annotated = shaped.map((r) => ({
        ...r,
        exception:
          !isDefenderActive(r) ||
          isExcepted(activeExceptions, null, { recommendationIds: r.recommendationIds }),
      }));
      return includeExceptions ? annotated : annotated.filter((r) => !r.exception);
    },
  );

  // Security Recommendations tab on the Devices page. Like the Defender portal's
  // own device page, this merges BOTH of the portal's Recommendations tables into
  // one list. Update recommendations are narrowed to the products this device is
  // actually exposed to (via its deviceVulnerabilities software rows, matched with
  // the same fuzzy product match used tenant-wide); misconfigurations are device
  // *configuration* findings with no meaningful productName, so a software match
  // would wrongly drop every one of them — they apply to the whole tenant.
  app.get<{ Params: { id: string }; Querystring: { includeExceptions?: string } }>(
    "/api/devices/:id/recommendations",
    async (req, reply) => {
      const deviceId = req.params.id;
      const thresholds = await loadSlaThresholds();
      const includeExceptions = req.query.includeExceptions === "true";

      if (config.DEMO_MODE) {
        const device = demoDevices.find((d) => d.id === deviceId);
        if (!device) return reply.code(404).send({ error: "not_found" });
        // Defender's device page shows no security recommendations for an
        // excluded device. Plain empty array rather than a wrapped shape: the tab
        // renders its explanatory empty state from the device row's own
        // `excluded` flag, which it already has from /api/devices.
        if ((await loadExcludedDeviceIndex(device.tenantId)).byDeviceId.has(device.id)) return [];
        if (!device.defenderMachineId) return [];

        const deviceLinks = demoDeviceVulnerabilities.filter(
          (dv) =>
            dv.tenantId === device.tenantId &&
            dv.defenderMachineId === device.defenderMachineId,
        );
        // No early-out on an empty software set: a device with no exposed
        // software still gets the tenant's misconfiguration recommendations.
        const deviceSoftware = new Set(
          deviceLinks.map((dv) => normalizeTitle(dv.software)).filter(Boolean),
        );

        const recRows = demoRecommendations.filter((r) => r.tenantId === device.tenantId);
        const scopeRows = demoDeviceVulnerabilities.filter((dv) => dv.tenantId === device.tenantId);
        const shaped = shapeRecommendations(recRows, thresholds, buildScopeIndex(scopeRows));
        const activeExceptions = await loadActiveExceptions(device.tenantId);
        const annotated = shaped
          .filter(
            (r) =>
              r.kind === "misconfiguration" ||
              matchesDeviceSoftware(r.productName, deviceSoftware),
          )
          .map((r) => ({
            ...r,
            exception:
              !isDefenderActive(r) ||
              isExcepted(activeExceptions, device.deviceGroupId, {
                recommendationIds: r.recommendationIds,
              }),
          }));
        return includeExceptions ? annotated : annotated.filter((r) => !r.exception);
      }

      const deviceRows = await db.select().from(tables.devices).where(eq(tables.devices.id, deviceId));
      const device = deviceRows[0];
      if (!device) return reply.code(404).send({ error: "not_found" });
      // Excluded devices show nothing here — see the demo branch above.
      if ((await loadExcludedDeviceIndex(device.tenantId)).byDeviceId.has(device.id)) return [];
      if (!device.defenderMachineId) return [];

      const links = await db
        .select({ software: tables.deviceVulnerabilities.software })
        .from(tables.deviceVulnerabilities)
        .where(
          and(
            eq(tables.deviceVulnerabilities.tenantId, device.tenantId),
            eq(tables.deviceVulnerabilities.defenderMachineId, device.defenderMachineId),
          ),
        );
      // No early-out on an empty software set — see the demo branch above.
      const deviceSoftware = new Set(links.map((l) => normalizeTitle(l.software)).filter(Boolean));

      const recRows = await db
        .select()
        .from(tables.recommendations)
        .where(eq(tables.recommendations.tenantId, device.tenantId));
      const scopeRows = await db
        .select({
          tenantId: tables.deviceVulnerabilities.tenantId,
          software: tables.deviceVulnerabilities.software,
          diskPaths: tables.deviceVulnerabilities.diskPaths,
          registryPaths: tables.deviceVulnerabilities.registryPaths,
        })
        .from(tables.deviceVulnerabilities)
        .where(eq(tables.deviceVulnerabilities.tenantId, device.tenantId));
      const shaped = shapeRecommendations(recRows, thresholds, buildScopeIndex(scopeRows));
      const activeExceptions = await loadActiveExceptions(device.tenantId);
      const annotated = shaped
        .filter(
          (r) =>
            r.kind === "misconfiguration" ||
            matchesDeviceSoftware(r.productName, deviceSoftware),
        )
        .map((r) => ({
          ...r,
          exception:
            !isDefenderActive(r) ||
            isExcepted(activeExceptions, device.deviceGroupId, {
              recommendationIds: r.recommendationIds,
            }),
        }));
      return includeExceptions ? annotated : annotated.filter((r) => !r.exception);
    },
  );

  // On-demand drill-down: the devices exposed to a recommendation, for the
  // Recommendations/Vulnerabilities side popout. Lives here (not routes/sync.ts)
  // so it also serves DEMO_MODE, which sync.ts hard-gates out. `recommendationIds`
  // is the comma-joined id list carried on each shaped row.
  app.get<{
    Querystring: { tenantId?: string; recommendationIds?: string; software?: string };
  }>(
    "/api/recommendations/exposed-devices",
    async (req, reply) => {
      const tenantId = req.query.tenantId;
      if (!tenantId) return reply.code(400).send({ error: "tenantId_required" });

      // The drill-down list has to agree with the count the row shows, so the
      // same devices adjustForExcludedDevices subtracted are dropped here.
      const excludedIndex = await loadExcludedDeviceIndex(tenantId);

      const recRows = config.DEMO_MODE
        ? demoRecommendations.filter((r) => r.tenantId === tenantId)
        : await db
            .select()
            .from(tables.recommendations)
            .where(eq(tables.recommendations.tenantId, tenantId));

      let recommendationIds = (req.query.recommendationIds ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // Fallback for callers that only know the software label (the Run Now
      // dialog opens from a vulnerability row, which carries no Defender
      // recommendation ids). Resolve the label to the tenant's matching
      // recommendation ids server-side, using the same normalized
      // either-contains match sync uses to join CVEs to recommendations.
      if (recommendationIds.length === 0 && req.query.software) {
        const target = normalizeTitle(req.query.software);
        if (target) {
          recommendationIds = recRows
            .filter((r) => {
              if (!isSoftwareRecommendation(r)) return false;
              const sw = normalizeTitle(friendlyProductName(r.productName, r.vendor));
              return !!sw && (sw === target || sw.includes(target) || target.includes(sw));
            })
            .map((r) => r.recommendationId);
        }
      }
      if (recommendationIds.length === 0) return [];

      const requested = recRows.filter((r) => recommendationIds.includes(r.recommendationId));
      // Misconfigurations are device-configuration findings that apply
      // tenant-wide, matching how the device tab includes them for every
      // device — no software to match them against, so no detection evidence.
      const hasMisconfiguration = requested.some(
        (r) => recommendationKind(r) === "misconfiguration",
      );
      const targets = hasMisconfiguration
        ? []
        : requested
            .map((r) => normalizeTitle(friendlyProductName(r.productName, r.vendor)))
            .filter(Boolean);

      if (config.DEMO_MODE) {
        if (requested.length === 0) return [];

        const evidenceByMachine = targets.length
          ? buildMachineEvidence(
              demoDeviceVulnerabilities.filter((dv) => dv.tenantId === tenantId),
              targets,
            )
          : new Map<string, { installedVersion: string | null; diskPaths: string[]; registryPaths: string[] }>();
        const toDevice = (d: (typeof demoDevices)[number]) => {
          const ev = d.defenderMachineId ? evidenceByMachine.get(d.defenderMachineId) : undefined;
          return {
            defenderMachineId: d.defenderMachineId,
            deviceName: d.hostname,
            owner: d.owner,
            lastSeen: d.lastSeen ? d.lastSeen.toISOString() : null,
            pendingReboot: null,
            installedVersion: ev?.installedVersion ?? null,
            diskPaths: ev?.diskPaths ?? [],
            registryPaths: ev?.registryPaths ?? [],
          };
        };
        const byLastSeen = (a: { lastSeen: string | null; deviceName: string }, b: typeof a) => {
          if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
          if (a.lastSeen) return -1;
          if (b.lastSeen) return 1;
          return a.deviceName.localeCompare(b.deviceName);
        };
        const tenantDevices = demoDevices.filter(
          (d) => d.tenantId === tenantId && !excludedIndex.byDeviceId.has(d.id),
        );

        if (hasMisconfiguration) {
          return tenantDevices.map(toDevice).sort(byLastSeen);
        }

        // Update recommendations: the devices whose exposed software matches the
        // requested products, via the same normalized either-contains match the
        // live path's software fallback uses.
        const exposedMachineIds = new Set(
          demoDeviceVulnerabilities
            .filter((dv) => {
              if (dv.tenantId !== tenantId) return false;
              const sw = normalizeTitle(dv.software);
              return (
                !!sw && targets.some((t) => sw === t || sw.includes(t) || t.includes(sw))
              );
            })
            .map((dv) => dv.defenderMachineId),
        );
        return tenantDevices
          .filter((d) => d.defenderMachineId && exposedMachineIds.has(d.defenderMachineId))
          .map(toDevice)
          .sort(byLastSeen);
      }

      const engineer = {
        upn: req.session.engineer!.upn,
        homeTenantId: req.session.engineer!.homeTenantId,
      };
      const exposed = await fetchExposedDevices(engineer, tenantId, recommendationIds, targets);
      if (excludedIndex.isEmpty) return exposed;
      return exposed.filter(
        (d) => !d.defenderMachineId || !excludedIndex.byMachineId.has(d.defenderMachineId),
      );
    },
  );

  // Scope-picker source for the Exception modal: distinct Defender device
  // groups (rbacGroupId/rbacGroupName, synced onto devices.deviceGroupId/Name
  // — see graph/sync.ts) seen among a tenant's devices. No new Defender call.
  app.get<{ Querystring: { tenantId?: string } }>("/api/device-groups", async (req, reply) => {
    const tenantId = req.query.tenantId;
    if (!tenantId) return reply.code(400).send({ error: "tenantId_required" });

    const rows = config.DEMO_MODE
      ? demoDevices.filter((d) => d.tenantId === tenantId)
      : await db.select().from(tables.devices).where(eq(tables.devices.tenantId, tenantId));

    const groups = new Map<string, string>();
    for (const d of rows) {
      if (d.deviceGroupId && !groups.has(d.deviceGroupId)) {
        groups.set(d.deviceGroupId, d.deviceGroupName ?? d.deviceGroupId);
      }
    }
    return [...groups.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  // Local exception records — list, per Exceptions tab / status filter reveal.
  app.get<{ Querystring: { tenantId?: string } }>(
    "/api/recommendations/exceptions",
    async (req, reply) => {
      const tenantId = req.query.tenantId;
      if (!tenantId) return reply.code(400).send({ error: "tenantId_required" });

      const rows = config.DEMO_MODE
        ? demoRecommendationExceptions.filter((e) => e.tenantId === tenantId)
        : await db
            .select()
            .from(tables.recommendationExceptions)
            .where(eq(tables.recommendationExceptions.tenantId, tenantId));

      return [...rows]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({
          ...r,
          // "expired" isn't stored — derived here so the UI's status filter
          // can distinguish it from an engineer-cancelled exception.
          derivedStatus: isExceptionLive(r) ? "active" : r.status === "cancelled" ? "cancelled" : "expired",
        }));
    },
  );

  interface CreateExceptionBody {
    tenantId?: string;
    recommendationId?: string | null;
    cveId?: string | null;
    scope?: "global" | "device-group";
    deviceGroupIds?: string[];
    justification?: string;
    notes?: string;
    durationDays?: number;
    expiresAt?: string;
  }

  app.post<{ Body: CreateExceptionBody }>(
    "/api/recommendations/exceptions",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const body = req.body ?? {};
    const { tenantId, scope, justification } = body;
    if (!tenantId || !scope || !justification) {
      return reply.code(400).send({ error: "tenantId, scope, and justification are required" });
    }
    if (!body.recommendationId && !body.cveId) {
      return reply.code(400).send({ error: "recommendationId or cveId is required" });
    }
    if (!(EXCEPTION_JUSTIFICATIONS as readonly string[]).includes(justification)) {
      return reply.code(400).send({ error: "invalid justification" });
    }
    if (scope === "device-group" && (!body.deviceGroupIds || body.deviceGroupIds.length === 0)) {
      return reply.code(400).send({ error: "deviceGroupIds is required for device-group scope" });
    }

    const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;
    const expiresAt = body.expiresAt
      ? new Date(body.expiresAt)
      : new Date(Date.now() + (body.durationDays ?? 90) * 24 * 60 * 60 * 1000);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() - Date.now() > MAX_DURATION_MS) {
      return reply.code(400).send({ error: "expiresAt must be a valid date within 1 year" });
    }

    const engineer = req.session.engineer!.upn;
    const row: RecommendationExceptionRow = {
      id: randomUUID(),
      tenantId,
      recommendationId: body.recommendationId?.trim() || null,
      cveId: body.cveId?.trim() || null,
      scope,
      deviceGroupIds: scope === "device-group" ? body.deviceGroupIds! : [],
      justification: justification as RecommendationExceptionRow["justification"],
      notes: body.notes?.trim() || null,
      expiresAt,
      status: "active",
      createdBy: engineer,
      createdAt: new Date(),
      cancelledAt: null,
    };

    if (config.DEMO_MODE) {
      demoRecommendationExceptions.unshift(row);
    } else {
      await db.insert(tables.recommendationExceptions).values(row);
    }

    // Synthetic, non-Graph audit entry — this is a local record only; the
    // engineer still has to apply the matching exception in the Defender
    // portal by hand, PatchPilot never calls Defender for it.
    await audit({
      engineer,
      tenantId,
      endpoint: "recommendation-exception:create",
      method: "POST",
      action: "exception:create",
      resourceType: "exception",
      resourceId: row.id,
      resourceLabel: exceptionLabel(row),
      summary: `Excepted ${exceptionLabel(row)} (${scope}, ${justification}) until ${expiresAt.toISOString().slice(0, 10)}`,
      outcome: "success",
      payload: { recommendationId: row.recommendationId, cveId: row.cveId, scope, justification },
      responseStatus: 201,
    });

    return reply.code(201).send({ ...row, derivedStatus: "active" });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/recommendations/exceptions/:id/cancel",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
      const { id } = req.params;
      const engineer = req.session.engineer!.upn;

      if (config.DEMO_MODE) {
        const row = demoRecommendationExceptions.find((e) => e.id === id);
        if (!row) return reply.code(404).send({ error: "not_found" });
        row.status = "cancelled";
        row.cancelledAt = new Date();
        await audit({
          engineer,
          tenantId: row.tenantId,
          endpoint: "recommendation-exception:cancel",
          method: "POST",
          action: "exception:cancel",
          resourceType: "exception",
          resourceId: id,
          resourceLabel: exceptionLabel(row),
          summary: `Cancelled the exception for ${exceptionLabel(row)}`,
          outcome: "success",
          payload: { id },
          responseStatus: 200,
        });
        return { ...row, derivedStatus: "cancelled" };
      }

      const existing = await db
        .select()
        .from(tables.recommendationExceptions)
        .where(eq(tables.recommendationExceptions.id, id));
      if (!existing[0]) return reply.code(404).send({ error: "not_found" });

      const [updated] = await db
        .update(tables.recommendationExceptions)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(tables.recommendationExceptions.id, id))
        .returning();
      if (!updated) return reply.code(404).send({ error: "not_found" });

      await audit({
        engineer,
        tenantId: updated.tenantId,
        endpoint: "recommendation-exception:cancel",
        method: "POST",
        action: "exception:cancel",
        resourceType: "exception",
        resourceId: id,
        resourceLabel: exceptionLabel(updated),
        summary: `Cancelled the exception for ${exceptionLabel(updated)}`,
        outcome: "success",
        payload: { id },
        responseStatus: 200,
      });

      return { ...updated, derivedStatus: "cancelled" };
    },
  );
}
