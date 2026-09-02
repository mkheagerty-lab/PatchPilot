import type { FastifyInstance } from "fastify";
import {
  db,
  tables,
  demoChocolateyCatalog,
  demoVulnerabilities,
  demoDevices,
  demoDeviceVulnerabilities,
  type VulnerabilityRow,
} from "@patchpilot/db";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  isOsFinding,
  resolveDisplaySoftwareName,
  matchChocolatey,
  type ChocolateyMatch,
} from "@patchpilot/shared";
import { config } from "../config.js";
import { audit } from "@patchpilot/graph";
import {
  refreshChocolateyCatalogFromMirror,
  isRefreshInProgress,
  MIRROR_SOURCE,
} from "../catalog/chocolatey-mirror.js";
import {
  loadChocolateyCatalog,
  loadChocolateyOverrides,
  indexChocolateyOverrides,
  toChocolateyEntries,
} from "../catalog/matching.js";
import {
  loadExcludedDeviceIndex,
  loadExcludedExposureBySoftware,
  excludedExposureKey,
} from "./device-exclusions.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Chocolatey catalog + coverage routes (Phase 5) — user-context counterpart to
 * routes/catalog.ts's winget routes. Same endpoint shape, deliberately
 * duplicated rather than generalized (see the plan's design decision): the
 * winget file is ~500 lines hard-coded end-to-end, and this is a
 * preview-quality page, so a second near-identical file is lower risk than a
 * shared abstraction over two catalogs with different mirror semantics
 * (winget's is a complete pull; Chocolatey's is best-effort/truncatable).
 *
 * DEMO_MODE serves from in-memory fixtures; production reads Postgres.
 */
const CHOCOLATEY_SOURCE_AUDIT_ENDPOINT = "chocolatey-mirror:source.odata";

export async function chocolateyCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("catalog:read"));

  async function loadVulns(): Promise<VulnerabilityRow[]> {
    if (config.DEMO_MODE) return demoVulnerabilities;
    return db.select().from(tables.vulnerabilities);
  }

  app.get("/api/chocolatey-catalog", async () => loadChocolateyCatalog());

  /** Lightweight package search for a future Run Now Chocolatey picker. */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/chocolatey-catalog/search",
    async (req) => {
      const q = (req.query?.q ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 50);
      if (!q) return [];

      if (config.DEMO_MODE) {
        const needle = q.toLowerCase();
        return demoChocolateyCatalog
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
        .from(tables.chocolateyCatalog)
        .where(
          or(
            ilike(tables.chocolateyCatalog.packageId, pattern),
            ilike(tables.chocolateyCatalog.name, pattern),
          ),
        )
        .orderBy(asc(tables.chocolateyCatalog.packageId))
        .limit(limit);
    },
  );

  app.get("/api/chocolatey-catalog/status", async () => {
    if (config.DEMO_MODE) {
      return {
        demo: true,
        total: demoChocolateyCatalog.length,
        mirror: 0,
        curated: demoChocolateyCatalog.length,
        lastRefreshedAt: null,
        refreshing: false,
      };
    }
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        mirror: sql<number>`count(*) filter (where ${tables.chocolateyCatalog.source} = ${MIRROR_SOURCE})::int`,
        lastRefreshedAt: sql<string | null>`max(${tables.chocolateyCatalog.lastRefreshedAt})`,
      })
      .from(tables.chocolateyCatalog);
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
   * Manually refresh from the live Chocolatey community feed. Best-effort:
   * the repository hard-caps paging (see chocolatey-mirror.ts), so a
   * refresh can succeed with `truncated: true` rather than failing outright.
   */
  app.post(
    "/api/chocolatey-catalog/refresh",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
    if (config.DEMO_MODE) {
      return reply.code(409).send({ error: "catalog refresh is unavailable in demo mode" });
    }
    if (isRefreshInProgress()) {
      return reply.code(409).send({ error: "a catalog refresh is already in progress" });
    }
    const engineer = req.session.engineer!.upn;
    const startedAt = Date.now();
    try {
      const result = await refreshChocolateyCatalogFromMirror();
      await audit({
        engineer,
        endpoint: CHOCOLATEY_SOURCE_AUDIT_ENDPOINT,
        method: "INGEST",
        action: "chocolatey-catalog:refresh",
        resourceType: "catalog",
        resourceLabel: "chocolatey",
        summary: `Refreshed the Chocolatey catalog — ${result.packages} packages${result.truncated ? " (truncated)" : ""}`,
        // A truncated refresh succeeded but is incomplete — "partial" is the
        // honest answer, and the reason is exactly what an auditor would ask for.
        outcome: result.truncated ? "partial" : "success",
        detail: result.truncationReason ?? null,
        responseStatus: 200,
        latencyMs: result.durationMs,
      });
      return {
        packages: result.packages,
        refreshedAt: result.refreshedAt.toISOString(),
        durationMs: result.durationMs,
        truncated: result.truncated,
        truncationReason: result.truncationReason ?? null,
      };
    } catch (err) {
      await audit({
        engineer,
        endpoint: CHOCOLATEY_SOURCE_AUDIT_ENDPOINT,
        method: "INGEST",
        action: "chocolatey-catalog:refresh",
        resourceType: "catalog",
        resourceLabel: "chocolatey",
        summary: "Chocolatey catalog refresh failed",
        outcome: "failure",
        detail: err instanceof Error ? err.message : String(err),
        responseStatus: 502,
        latencyMs: Date.now() - startedAt,
      });
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "chocolatey catalog refresh failed");
      return reply.code(502).send({ error: `catalog refresh failed: ${message}` });
    }
    },
  );

  app.get<{ Querystring: { tenantId?: string } }>("/api/chocolatey-catalog/coverage", async (req) => {
    const catalog = await loadChocolateyCatalog();
    const entries = toChocolateyEntries(catalog);

    const allVulns = await loadVulns();
    const vulns = req.query.tenantId
      ? allVulns.filter((v) => v.tenantId === req.query.tenantId)
      : allVulns;

    const { global: globalOverrides, byTenant } = indexChocolateyOverrides(
      await loadChocolateyOverrides(),
    );

    const excluded = await loadExcludedDeviceIndex(req.query.tenantId);
    const excludedExposure = await loadExcludedExposureBySoftware(excluded);

    const latestByPackageId = new Map<string, string | null>(
      catalog.map((c) => [c.packageId, c.latestVersion]),
    );

    const SEVERITY_RANK: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    interface Group {
      tenantId: string;
      software: string;
      publisher: string | null;
      severity: string;
      severityRank: number;
      patchType: "app" | "os";
      match: ChocolateyMatch | null;
      latestVersion: string | null;
      cveIds: string[];
      affectedDeviceCount: number;
      vulnId: string;
    }

    const groups = new Map<string, Group>();
    for (const v of vulns) {
      const key = `${v.tenantId}\u0000${v.software.trim().toLowerCase()}`;
      const isOs = isOsFinding(v.software);
      const overrides = [...(byTenant.get(v.tenantId) ?? []), ...globalOverrides];
      const match: ChocolateyMatch | null = isOs
        ? null
        : matchChocolatey(v.software, entries, overrides);
      const rank = SEVERITY_RANK[v.severity] ?? 0;

      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          tenantId: v.tenantId,
          software: v.software,
          publisher: v.publisher,
          severity: v.severity,
          severityRank: rank,
          patchType: isOs ? "os" : "app",
          match,
          latestVersion: match ? latestByPackageId.get(match.packageId) ?? null : null,
          cveIds: [v.cveId],
          affectedDeviceCount: v.affectedDeviceCount,
          vulnId: v.id,
        });
        continue;
      }
      existing.cveIds.push(v.cveId);
      existing.affectedDeviceCount = Math.max(existing.affectedDeviceCount, v.affectedDeviceCount);
      if (rank > existing.severityRank) {
        existing.severity = v.severity;
        existing.severityRank = rank;
        existing.vulnId = v.id;
      }
    }

    // Excluded devices stop contributing to coverage exposure — same subtraction
    // (never a recomputation) routes/catalog.ts applies to the winget table.
    const surviving = excluded.isEmpty
      ? [...groups.values()]
      : [...groups.values()].flatMap((g) => {
          const gone = excludedExposure.get(excludedExposureKey(g.tenantId, g.software))?.size ?? 0;
          if (gone === 0) return [g];
          const affectedDeviceCount = Math.max(0, g.affectedDeviceCount - gone);
          if (g.affectedDeviceCount > 0 && affectedDeviceCount === 0) return [];
          return [{ ...g, affectedDeviceCount }];
        });

    const rows = surviving
      .sort(
        (a, b) =>
          b.severityRank - a.severityRank ||
          b.affectedDeviceCount - a.affectedDeviceCount ||
          a.software.localeCompare(b.software),
      )
      .map((g) => {
        const applicable = g.patchType === "app";
        const status: "covered" | "not-supported" | "os" = !applicable
          ? "os"
          : g.match
            ? "covered"
            : "not-supported";
        return {
          tenantId: g.tenantId,
          software: g.software,
          displayName: resolveDisplaySoftwareName(g.software),
          publisher: g.publisher,
          severity: g.severity as "critical" | "high" | "medium" | "low",
          patchType: g.patchType,
          applicable,
          status,
          match: g.match,
          latestVersion: g.latestVersion,
          cveCount: g.cveIds.length,
          cveIds: g.cveIds,
          affectedDeviceCount: g.affectedDeviceCount,
          vulnId: g.vulnId,
        };
      });

    const appRows = rows.filter((r) => r.applicable);
    const covered = appRows.filter((r) => r.match).length;

    return {
      tenantId: req.query.tenantId ?? null,
      // Summed from the surviving rows so a fully-excluded group takes its CVEs
      // with it; identical to `vulns.length` when nothing is excluded.
      findingCount: rows.reduce((n, r) => n + r.cveCount, 0),
      total: rows.length,
      applicable: appRows.length,
      covered,
      uncovered: appRows.length - covered,
      os: rows.length - appRows.length,
      rows,
    };
  });

  /**
   * On-demand drill-down for a coverage row's exposed devices — same shape
   * and query as routes/catalog.ts's /api/catalog/exposed-devices.
   */
  app.get<{ Querystring: { tenantId?: string; software?: string } }>(
    "/api/chocolatey-catalog/exposed-devices",
    async (req, reply) => {
      const tenantId = req.query.tenantId?.trim();
      const software = req.query.software?.trim();
      if (!tenantId || !software) {
        return reply.code(400).send({ error: "tenantId and software are required" });
      }
      const softwareKey = software.toLowerCase();
      // Same devices the coverage row's count subtracted, so the popout agrees
      // with the number that opened it.
      const excludedDevices = await loadExcludedDeviceIndex(tenantId);

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
            .filter((v) => v.tenantId === tenantId && v.software.trim().toLowerCase() === softwareKey)
            .map((v) => v.cveId),
        );
        if (cveIds.size === 0) return [];
        const machineIds = new Set(
          demoDeviceVulnerabilities
            .filter((dv) => dv.tenantId === tenantId && cveIds.has(dv.cveId))
            .map((dv) => dv.defenderMachineId),
        );
        for (const id of excludedDevices.byMachineId.keys()) machineIds.delete(id);
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
          cveRows.filter((v) => v.software.trim().toLowerCase() === softwareKey).map((v) => v.cveId),
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
      for (const id of excludedDevices.byMachineId.keys()) machineIds.delete(id);
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

  app.get<{ Querystring: { tenantId?: string } }>("/api/chocolatey-catalog/overrides", async (req) => {
    const rows = await loadChocolateyOverrides();
    return req.query.tenantId ? rows.filter((r) => r.tenantId === req.query.tenantId) : rows;
  });

  app.post<{ Body: { tenantId?: string | null; softwareTitle?: string; packageId?: string } }>(
    "/api/chocolatey-catalog/overrides",
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
        .insert(tables.chocolateyCatalogOverride)
        .values({ tenantId, softwareTitle, packageId, createdBy: engineer })
        .returning();
      await audit({
        engineer,
        tenantId,
        endpoint: "chocolatey-catalog:override",
        method: "POST",
        action: "chocolatey-catalog:override-create",
        resourceType: "catalog-override",
        resourceId: row?.id ?? null,
        resourceLabel: softwareTitle,
        summary: `Pinned "${softwareTitle}" to Chocolatey package ${packageId}${tenantId ? "" : " (all tenants)"}`,
        outcome: "success",
        payload: { softwareTitle, packageId },
        responseStatus: 201,
      });
      return reply.code(201).send(row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/chocolatey-catalog/overrides/:id",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
    if (config.DEMO_MODE) {
      return reply.code(409).send({ error: "catalog overrides are read-only in demo mode" });
    }
    const { id } = req.params;
    const [deleted] = await db
      .delete(tables.chocolateyCatalogOverride)
      .where(eq(tables.chocolateyCatalogOverride.id, id))
      .returning();
    if (!deleted) {
      return reply.code(404).send({ error: "override not found" });
    }
    await audit({
      engineer: req.session.engineer!.upn,
      tenantId: deleted.tenantId,
      endpoint: "chocolatey-catalog:override",
      method: "DELETE",
      action: "chocolatey-catalog:override-delete",
      resourceType: "catalog-override",
      resourceId: id,
      resourceLabel: deleted.softwareTitle,
      summary: `Removed the Chocolatey pin for "${deleted.softwareTitle}" (${deleted.packageId})`,
      outcome: "success",
      payload: { id },
      responseStatus: 200,
    });
    return { deleted: true };
    },
  );
}
