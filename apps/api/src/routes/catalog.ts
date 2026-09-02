import type { FastifyInstance } from "fastify";
import {
  db,
  tables,
  demoWingetCatalog,
  demoVulnerabilities,
  demoDevices,
  demoDeviceVulnerabilities,
} from "@patchpilot/db";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { audit } from "@patchpilot/graph";
import {
  refreshWingetCatalogFromMirror,
  isRefreshInProgress,
  MIRROR_SOURCE,
} from "../catalog/winget-mirror.js";
import {
  loadWingetCatalog,
  loadWingetOverrides,
  buildWingetMatcher,
  buildChocolateyMatcher,
  loadChocolateyCatalog,
} from "../catalog/matching.js";
import { computeCoverage } from "../catalog/coverage.js";
import { loadExcludedDeviceIndex } from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Winget catalog + coverage routes (Phase 2).
 *
 * The catalog is the MDVM-software-title -> winget-package-id mapping. Coverage
 * runs that mapping over a tenant's vulnerabilities so engineers can see, before
 * any remediation, which findings PatchPilot can actually drive via winget.
 *
 * DEMO_MODE serves from in-memory fixtures; production reads Postgres. No
 * Microsoft calls — this is pure local mapping.
 */
/** Synthetic audit endpoint for the local winget-mirror ingestion (not a Graph call). */
const WINGET_SOURCE_AUDIT_ENDPOINT = "winget-mirror:source.msix";

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("catalog:read"));

  app.get("/api/catalog", async () => loadWingetCatalog());

  /**
   * Lightweight package search for the Run Now dialog's winget picker. The full
   * mirror is ~13k rows — far too heavy to ship to a modal — so this matches the
   * query against package id and display name in SQL and returns a short page.
   */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/catalog/search",
    async (req) => {
      const q = (req.query?.q ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 50);
      if (!q) return [];

      if (config.DEMO_MODE) {
        const needle = q.toLowerCase();
        return demoWingetCatalog
          .filter(
            (p) =>
              p.packageId.toLowerCase().includes(needle) ||
              p.name.toLowerCase().includes(needle),
          )
          .slice(0, limit);
      }

      const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;
      return db
        .select()
        .from(tables.wingetCatalog)
        .where(
          or(
            ilike(tables.wingetCatalog.packageId, pattern),
            ilike(tables.wingetCatalog.name, pattern),
          ),
        )
        .orderBy(asc(tables.wingetCatalog.packageId))
        .limit(limit);
    },
  );

  /**
   * Auto-match a software title against both catalogs for the Run Now
   * dialog's Winget/Chocolatey pickers, so they can open pre-selected
   * ("locked in") instead of a blank search box. Same live matchers
   * `/api/software-inventory/:softwareId/devices` uses per-device — this
   * just resolves one (tenantId, software) pair with no device fan-out,
   * since neither picker's auto-match depends on which device is selected.
   */
  app.get<{ Querystring: { software?: string; tenantId?: string } }>(
    "/api/catalog/match",
    async (req, reply) => {
      const { tenantId } = req.query;
      const software = (req.query?.software ?? "").trim();
      if (!tenantId) return reply.code(400).send({ error: "tenantId is required" });
      if (!software) return { winget: null, chocolatey: null };

      const [wingetCatalog, chocolateyCatalog, wingetMatcher, chocolateyMatcher] =
        await Promise.all([
          loadWingetCatalog(),
          loadChocolateyCatalog(),
          buildWingetMatcher(),
          buildChocolateyMatcher(),
        ]);
      const wingetMatch = wingetMatcher(tenantId, software);
      const chocolateyMatch = chocolateyMatcher(tenantId, software);
      const wingetLatestById = new Map(wingetCatalog.map((c) => [c.packageId, c.latestVersion]));
      const chocolateyLatestById = new Map(
        chocolateyCatalog.map((c) => [c.packageId, c.latestVersion]),
      );

      return {
        winget: wingetMatch
          ? {
              packageId: wingetMatch.packageId,
              name: wingetMatch.name,
              latestVersion: wingetLatestById.get(wingetMatch.packageId) ?? null,
            }
          : null,
        chocolatey: chocolateyMatch
          ? {
              packageId: chocolateyMatch.packageId,
              name: chocolateyMatch.name,
              latestVersion: chocolateyLatestById.get(chocolateyMatch.packageId) ?? null,
            }
          : null,
      };
    },
  );

  /**
   * Catalog freshness summary for the Catalog page: how many packages we hold,
   * how many came from the winget mirror, and when the mirror was last pulled.
   * In demo the curated fixtures have no mirror provenance, so it reports the
   * fixture count with a null refresh time.
   */
  app.get("/api/catalog/status", async () => {
    if (config.DEMO_MODE) {
      return {
        demo: true,
        total: demoWingetCatalog.length,
        mirror: 0,
        curated: demoWingetCatalog.length,
        lastRefreshedAt: null,
        refreshing: false,
      };
    }
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        mirror: sql<number>`count(*) filter (where ${tables.wingetCatalog.source} = ${MIRROR_SOURCE})::int`,
        lastRefreshedAt: sql<string | null>`max(${tables.wingetCatalog.lastRefreshedAt})`,
      })
      .from(tables.wingetCatalog);
    const total = row?.total ?? 0;
    const mirror = row?.mirror ?? 0;
    return {
      demo: false,
      total,
      mirror,
      curated: total - mirror,
      lastRefreshedAt: row?.lastRefreshedAt ?? null,
      refreshing: isRefreshInProgress(),
    };
  });

  /**
   * Manually refresh the package catalog from the live winget mirror. This is a
   * read from a public CDN whose only writes land in our own `winget_catalog`,
   * so it is audited as a local ingestion (no Microsoft tenant is touched).
   * Disabled in DEMO_MODE, where the catalog is fixtures.
   */
  app.post("/api/catalog/refresh", { preHandler: requirePermission("catalog:write") }, async (req, reply) => {
    if (config.DEMO_MODE) {
      return reply.code(409).send({ error: "catalog refresh is unavailable in demo mode" });
    }
    if (isRefreshInProgress()) {
      return reply.code(409).send({ error: "a catalog refresh is already in progress" });
    }
    const engineer = req.session.engineer!.upn;
    const startedAt = Date.now();
    try {
      const result = await refreshWingetCatalogFromMirror();
      await audit({
        engineer,
        endpoint: WINGET_SOURCE_AUDIT_ENDPOINT,
        method: "INGEST",
        action: "catalog:refresh",
        resourceType: "catalog",
        resourceLabel: "winget",
        summary: `Refreshed the winget catalog — ${result.packages} packages`,
        outcome: "success",
        responseStatus: 200,
        latencyMs: result.durationMs,
      });
      return {
        packages: result.packages,
        refreshedAt: result.refreshedAt.toISOString(),
        durationMs: result.durationMs,
      };
    } catch (err) {
      await audit({
        engineer,
        endpoint: WINGET_SOURCE_AUDIT_ENDPOINT,
        method: "INGEST",
        action: "catalog:refresh",
        resourceType: "catalog",
        resourceLabel: "winget",
        summary: "Winget catalog refresh failed",
        outcome: "failure",
        detail: err instanceof Error ? err.message : String(err),
        responseStatus: 502,
        latencyMs: Date.now() - startedAt,
      });
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "winget catalog refresh failed");
      return reply.code(502).send({ error: `catalog refresh failed: ${message}` });
    }
  });

  // Body lives in catalog/coverage.ts so the posture snapshotter records the
  // very same covered/uncovered/os counts this route serves.
  app.get<{ Querystring: { tenantId?: string } }>("/api/catalog/coverage", async (req) =>
    computeCoverage(req.query.tenantId),
  );


  /**
   * On-demand drill-down for a coverage row: the devices exposed to a software
   * title, for the Catalog side popout. A coverage row is a (tenant, software)
   * group, so we resolve the software's CVEs and union the devices linked to any
   * of them via the persisted device⇄CVE table — the inverse of
   * `/api/devices/:id/vulnerabilities`. Pure local read, no Microsoft calls.
   * Returns the same `ExposedDevice` shape the Vulnerabilities popout consumes.
   */
  app.get<{ Querystring: { tenantId?: string; software?: string } }>(
    "/api/catalog/exposed-devices",
    async (req, reply) => {
      const tenantId = req.query.tenantId?.trim();
      const software = req.query.software?.trim();
      if (!tenantId || !software) {
        return reply.code(400).send({ error: "tenantId and software are required" });
      }
      const softwareKey = software.toLowerCase();
      // Same devices the coverage row's count subtracted, so the popout agrees
      // with the number that opened it.
      const excluded = await loadExcludedDeviceIndex(tenantId);

      interface ExposedDevice {
        defenderMachineId: string | null;
        deviceName: string;
        owner: string | null;
        lastSeen: string | null;
        pendingReboot: boolean | null;
      }
      const bySeen = (a: ExposedDevice, b: ExposedDevice): number => {
        if (a.lastSeen && b.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
        if (a.lastSeen) return -1;
        if (b.lastSeen) return 1;
        return a.deviceName.localeCompare(b.deviceName);
      };

      if (config.DEMO_MODE) {
        const cveIds = new Set(
          demoVulnerabilities
            .filter(
              (v) =>
                v.tenantId === tenantId && v.software.trim().toLowerCase() === softwareKey,
            )
            .map((v) => v.cveId),
        );
        if (cveIds.size === 0) return [];
        const machineIds = new Set(
          demoDeviceVulnerabilities
            .filter((dv) => dv.tenantId === tenantId && cveIds.has(dv.cveId))
            .map((dv) => dv.defenderMachineId),
        );
        for (const id of excluded.byMachineId.keys()) machineIds.delete(id);
        return demoDevices
          .filter((d) => d.defenderMachineId && machineIds.has(d.defenderMachineId))
          .map((d) => ({
            defenderMachineId: d.defenderMachineId,
            deviceName: d.hostname,
            owner: d.owner,
            lastSeen: d.lastSeen ? d.lastSeen.toISOString() : null,
            pendingReboot: null,
          }))
          .sort(bySeen);
      }

      const cveRows = await db
        .select({ cveId: tables.vulnerabilities.cveId, software: tables.vulnerabilities.software })
        .from(tables.vulnerabilities)
        .where(eq(tables.vulnerabilities.tenantId, tenantId));
      const cveIds = [
        ...new Set(
          cveRows
            .filter((v) => v.software.trim().toLowerCase() === softwareKey)
            .map((v) => v.cveId),
        ),
      ];
      if (cveIds.length === 0) return [];

      const links = await db
        .select({ defenderMachineId: tables.deviceVulnerabilities.defenderMachineId })
        .from(tables.deviceVulnerabilities)
        .where(
          and(
            eq(tables.deviceVulnerabilities.tenantId, tenantId),
            inArray(tables.deviceVulnerabilities.cveId, cveIds),
          ),
        );
      const machineIds = new Set(links.map((l) => l.defenderMachineId));
      for (const id of excluded.byMachineId.keys()) machineIds.delete(id);
      if (machineIds.size === 0) return [];

      const deviceRows = await db
        .select({
          defenderMachineId: tables.devices.defenderMachineId,
          hostname: tables.devices.hostname,
          owner: tables.devices.owner,
          lastSeen: tables.devices.lastSeen,
        })
        .from(tables.devices)
        .where(eq(tables.devices.tenantId, tenantId));

      return deviceRows
        .filter((d) => d.defenderMachineId && machineIds.has(d.defenderMachineId))
        .map((d) => ({
          defenderMachineId: d.defenderMachineId,
          deviceName: d.hostname,
          owner: d.owner,
          lastSeen: d.lastSeen ? d.lastSeen.toISOString() : null,
          pendingReboot: null,
        }))
        .sort(bySeen);
    },
  );

  /**
   * Engineer-authored software-title -> winget-package pins. A pin with a
   * tenantId is scoped to that customer; a null tenantId is a global default.
   * These override the fuzzy matcher (a `manual` match at full confidence), so
   * an engineer can map a title the heuristics miss or correct a wrong guess.
   */
  app.get<{ Querystring: { tenantId?: string } }>("/api/catalog/overrides", async (req) => {
    const rows = await loadWingetOverrides();
    const filtered = req.query.tenantId
      ? rows.filter((r) => r.tenantId === req.query.tenantId)
      : rows;
    return filtered;
  });

  app.post<{ Body: { tenantId?: string | null; softwareTitle?: string; packageId?: string } }>(
    "/api/catalog/overrides",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "catalog overrides are read-only in demo mode" });
      }
      const tenantId = req.body.tenantId?.trim() || null;
      const softwareTitle = req.body.softwareTitle?.trim();
      const packageId = req.body.packageId?.trim();
      if (!softwareTitle || !packageId) {
        return reply.code(400).send({ error: "softwareTitle and packageId are required" });
      }
      const engineer = req.session.engineer!.upn;
      const [row] = await db
        .insert(tables.wingetCatalogOverride)
        .values({ tenantId, softwareTitle, packageId, createdBy: engineer })
        .returning();
      await audit({
        engineer,
        tenantId,
        endpoint: "catalog:override",
        method: "POST",
        action: "catalog:override-create",
        resourceType: "catalog-override",
        resourceId: row?.id ?? null,
        resourceLabel: softwareTitle,
        summary: `Pinned "${softwareTitle}" to winget package ${packageId}${tenantId ? "" : " (all tenants)"}`,
        outcome: "success",
        payload: { softwareTitle, packageId },
        responseStatus: 201,
      });
      return reply.code(201).send(row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/catalog/overrides/:id",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
    if (config.DEMO_MODE) {
      return reply.code(409).send({ error: "catalog overrides are read-only in demo mode" });
    }
    const { id } = req.params;
    const [deleted] = await db
      .delete(tables.wingetCatalogOverride)
      .where(eq(tables.wingetCatalogOverride.id, id))
      .returning();
    if (!deleted) {
      return reply.code(404).send({ error: "override not found" });
    }
    await audit({
      engineer: req.session.engineer!.upn,
      tenantId: deleted.tenantId,
      endpoint: "catalog:override",
      method: "DELETE",
      action: "catalog:override-delete",
      resourceType: "catalog-override",
      resourceId: id,
      // Captured from the returned row: after the delete there is nothing left
      // to join against, so the label has to be denormalised here or lost.
      resourceLabel: deleted.softwareTitle,
      summary: `Removed the winget pin for "${deleted.softwareTitle}" (${deleted.packageId})`,
      outcome: "success",
      payload: { id },
      responseStatus: 200,
    });
    return { deleted: true };
    },
  );
}
