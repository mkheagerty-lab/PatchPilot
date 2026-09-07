import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db, tables, demoScriptCatalog } from "@patchpilot/db";
import { config } from "../config.js";
import { audit } from "@patchpilot/graph";
import { requirePermission } from "../auth/rbac.js";

/**
 * Script Catalog — engineer-uploaded scripts (Remediation Options
 * "Manual -> dispatch" and Catalog = Script). Preview quality: dispatch only
 * happens via the Intune (Platform/Remediation Script) channel today, which
 * itself always reports `notPerformed` in the worker.
 *
 * `scriptType` is organisational only: Intune's deviceHealthScripts accepts
 * PowerShell alone, so cmd/bash scripts can be catalogued, downloaded and
 * exported but are not selectable for dispatch (RunNowModal disables them).
 *
 * Not a mirrored repo like winget/chocolatey — these are hand-authored, so
 * there is no refresh/coverage concept, just CRUD. A null tenantId is a
 * global script, mirroring wingetCatalogOverride's convention.
 *
 * DEMO_MODE never queries Postgres (see config.ts): every route below forks
 * onto `demoScripts`, an in-memory array seeded from fixtures and mutated in
 * place by the same CRUD the real routes do — same pattern as jobs.ts's
 * demoJobLog, so create/archive/delete genuinely persist for the rest of the
 * demo session (until the process restarts).
 */
export type ScriptType = "powershell" | "cmd" | "bash";

const SCRIPT_TYPES: readonly ScriptType[] = ["powershell", "cmd", "bash"];

export interface ScriptCatalogEntry {
  id: string;
  tenantId: string | null;
  name: string;
  description: string | null;
  scriptType: ScriptType;
  scriptContent: string;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

type ScriptCatalogRow = InferSelectModel<typeof tables.scriptCatalog>;

function rowToEntry(row: ScriptCatalogRow): ScriptCatalogEntry {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description,
    scriptType: row.scriptType,
    scriptContent: row.scriptContent,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** Same truncating join as the Jobs bulk endpoints, so audit detail stays readable. */
function idList(items: readonly string[], max = 10): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} + ${items.length - max} more`;
}

/** Newest-first in-memory script log used only in DEMO_MODE, seeded from fixtures. */
const demoScripts: ScriptCatalogEntry[] = demoScriptCatalog
  .map(rowToEntry)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** Same tenant-or-global visibility rule as `visibleTo` below, applied in memory. */
function demoVisibleTo(entry: ScriptCatalogEntry, tenantId: string): boolean {
  return entry.tenantId === null || entry.tenantId === tenantId;
}

interface CreateBody {
  tenantId?: string | null;
  name?: string;
  description?: string;
  scriptType?: string;
  scriptContent?: string;
}

/**
 * Tenant-scoped scripts plus global (null-tenant) ones. Every mutating route
 * reuses this so a caller can only ever touch rows the active tenant can see —
 * without it, a bare id would reach across tenants.
 */
function visibleTo(tenantId: string) {
  return or(eq(tables.scriptCatalog.tenantId, tenantId), isNull(tables.scriptCatalog.tenantId))!;
}

export async function scriptCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("catalog:read"));

  app.get<{ Querystring: { tenantId?: string; includeArchived?: string } }>(
    "/api/script-catalog",
    async (req, reply) => {
      const tenantId = req.query.tenantId?.trim();
      // Required, not optional: an absent tenantId used to fall through to an
      // undefined where clause, which returned every tenant's scripts.
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      const includeArchived = req.query.includeArchived === "true";
      if (config.DEMO_MODE) {
        return demoScripts
          .filter((s) => demoVisibleTo(s, tenantId))
          .filter((s) => includeArchived || !s.archivedAt);
      }
      const rows = await db
        .select()
        .from(tables.scriptCatalog)
        .where(
          includeArchived
            ? visibleTo(tenantId)
            : and(visibleTo(tenantId), isNull(tables.scriptCatalog.archivedAt)),
        )
        .orderBy(desc(tables.scriptCatalog.createdAt));
      return rows.map(rowToEntry);
    },
  );

  app.post<{ Body: CreateBody }>(
    "/api/script-catalog",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
    const { tenantId, name, description, scriptType, scriptContent } = req.body ?? {};
    const trimmedName = name?.trim();
    const trimmedScript = scriptContent?.trim();
    if (!trimmedName || !trimmedScript) {
      return reply.code(400).send({ error: "name and scriptContent are required" });
    }
    // Absent means PowerShell — keeps every pre-existing caller working.
    const type = (scriptType?.trim() || "powershell") as ScriptType;
    if (!SCRIPT_TYPES.includes(type)) {
      return reply.code(400).send({ error: `scriptType must be one of ${SCRIPT_TYPES.join(", ")}` });
    }

    const engineer = req.session.engineer!.upn;

    if (config.DEMO_MODE) {
      const entry: ScriptCatalogEntry = {
        id: randomUUID(),
        tenantId: tenantId?.trim() || null,
        name: trimmedName,
        description: description?.trim() || null,
        scriptType: type,
        scriptContent: trimmedScript,
        createdBy: engineer,
        createdAt: new Date().toISOString(),
        archivedAt: null,
      };
      demoScripts.unshift(entry);
      await audit({
        engineer,
        tenantId: entry.tenantId,
        endpoint: "script-catalog:upload",
        method: "POST",
        action: "script:upload",
        resourceType: "script",
        resourceId: entry.id,
        resourceLabel: trimmedName,
        summary: `Uploaded the "${trimmedName}" ${type} script${entry.tenantId ? "" : " (all tenants)"}`,
        outcome: "success",
        payload: { name: trimmedName, scriptType: type },
        responseStatus: 201,
      });
      return reply.code(201).send(entry);
    }

    const [row] = await db
      .insert(tables.scriptCatalog)
      .values({
        tenantId: tenantId?.trim() || null,
        name: trimmedName,
        description: description?.trim() || null,
        scriptType: type,
        scriptContent: trimmedScript,
        createdBy: engineer,
      })
      .returning();

    await audit({
      engineer,
      tenantId: row!.tenantId,
      endpoint: "script-catalog:upload",
      method: "POST",
      action: "script:upload",
      resourceType: "script",
      resourceId: row!.id,
      resourceLabel: trimmedName,
      summary: `Uploaded the "${trimmedName}" ${type} script${row!.tenantId ? "" : " (all tenants)"}`,
      outcome: "success",
      payload: { name: trimmedName, scriptType: type },
      responseStatus: 201,
    });

    return reply.code(201).send(rowToEntry(row!));
    },
  );

  /** Archive / restore a single script. Soft-hide only — the row stays queryable. */
  app.patch<{ Params: { id: string }; Body: { tenantId?: string; archived?: boolean } }>(
    "/api/script-catalog/:id",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
      const tenantId = req.body?.tenantId?.trim();
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      const archived = req.body?.archived !== false;

      if (config.DEMO_MODE) {
        const entry = demoScripts.find((s) => s.id === req.params.id && demoVisibleTo(s, tenantId));
        if (!entry) {
          return reply.code(404).send({ error: "script not found" });
        }
        entry.archivedAt = archived ? new Date().toISOString() : null;
        await audit({
          engineer: req.session.engineer!.upn,
          tenantId: entry.tenantId,
          endpoint: "script-catalog:archive",
          method: "PATCH",
          action: archived ? "script:archive" : "script:restore",
          resourceType: "script",
          resourceId: entry.id,
          resourceLabel: entry.name,
          summary: `${archived ? "Archived" : "Restored"} the "${entry.name}" script`,
          outcome: "success",
          payload: { id: entry.id, archived },
          responseStatus: 200,
        });
        return entry;
      }

      const [row] = await db
        .update(tables.scriptCatalog)
        .set({ archivedAt: archived ? new Date() : null })
        .where(and(eq(tables.scriptCatalog.id, req.params.id), visibleTo(tenantId)))
        .returning();
      if (!row) {
        return reply.code(404).send({ error: "script not found" });
      }
      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: row.tenantId,
        endpoint: "script-catalog:archive",
        method: "PATCH",
        action: archived ? "script:archive" : "script:restore",
        resourceType: "script",
        resourceId: row.id,
        resourceLabel: row.name,
        summary: `${archived ? "Archived" : "Restored"} the "${row.name}" script`,
        outcome: "success",
        payload: { id: row.id, archived },
        responseStatus: 200,
      });
      return rowToEntry(row);
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { tenantId?: string } }>(
    "/api/script-catalog/:id",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
      const tenantId = req.query.tenantId?.trim();
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }

      if (config.DEMO_MODE) {
        const index = demoScripts.findIndex((s) => s.id === req.params.id && demoVisibleTo(s, tenantId));
        if (index === -1) {
          return reply.code(404).send({ error: "script not found" });
        }
        const [deleted] = demoScripts.splice(index, 1);
        await audit({
          engineer: req.session.engineer!.upn,
          tenantId: deleted!.tenantId,
          endpoint: "script-catalog:upload",
          method: "DELETE",
          action: "script:delete",
          resourceType: "script",
          resourceId: req.params.id,
          resourceLabel: deleted!.name,
          summary: `Deleted the "${deleted!.name}" script`,
          outcome: "success",
          payload: { id: req.params.id },
          responseStatus: 200,
        });
        return { deleted: true };
      }

      const [deleted] = await db
        .delete(tables.scriptCatalog)
        .where(and(eq(tables.scriptCatalog.id, req.params.id), visibleTo(tenantId)))
        .returning();
      if (!deleted) {
        return reply.code(404).send({ error: "script not found" });
      }
      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: deleted.tenantId,
        endpoint: "script-catalog:upload",
        method: "DELETE",
        action: "script:delete",
        resourceType: "script",
        resourceId: req.params.id,
        resourceLabel: deleted.name,
        summary: `Deleted the "${deleted.name}" script`,
        outcome: "success",
        payload: { id: req.params.id },
        responseStatus: 200,
      });
      return { deleted: true };
    },
  );

  // Bulk variants back the Script Catalog page's multi-select toolbar, mirroring
  // /api/jobs/bulk-archive and /api/jobs/bulk-delete: ids that don't resolve are
  // reported back rather than failing the batch, and the whole batch produces a
  // single audit row — 40 selected scripts is one decision, not 40.
  app.post<{ Body: { tenantId?: string; ids?: string[]; archived?: boolean } }>(
    "/api/script-catalog/bulk-archive",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
      const { tenantId, ids, archived = true } = req.body ?? {};
      if (!tenantId?.trim()) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }
      const trimmedTenant = tenantId.trim();

      if (config.DEMO_MODE) {
        const updated: string[] = [];
        for (const entry of demoScripts) {
          if (ids.includes(entry.id) && demoVisibleTo(entry, trimmedTenant)) {
            entry.archivedAt = archived ? new Date().toISOString() : null;
            updated.push(entry.id);
          }
        }
        const notFound = ids.filter((id) => !updated.includes(id));
        await audit({
          engineer: req.session.engineer!.upn,
          tenantId: trimmedTenant,
          endpoint: "/api/script-catalog/bulk-archive",
          method: "POST",
          action: archived ? "script:bulk-archive" : "script:bulk-restore",
          resourceType: "script",
          summary: `${archived ? "Archived" : "Restored"} ${updated.length} of ${ids.length} scripts`,
          outcome: notFound.length ? "partial" : "success",
          detail: notFound.length ? `Not found: ${idList(notFound)}` : null,
          responseStatus: 200,
        });
        return { updated, notFound };
      }

      const rows = await db
        .update(tables.scriptCatalog)
        .set({ archivedAt: archived ? new Date() : null })
        .where(and(inArray(tables.scriptCatalog.id, ids), visibleTo(trimmedTenant)))
        .returning();
      const updated = rows.map((r) => r.id);
      const notFound = ids.filter((id) => !updated.includes(id));

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: trimmedTenant,
        endpoint: "/api/script-catalog/bulk-archive",
        method: "POST",
        action: archived ? "script:bulk-archive" : "script:bulk-restore",
        resourceType: "script",
        summary: `${archived ? "Archived" : "Restored"} ${updated.length} of ${ids.length} scripts`,
        outcome: notFound.length ? "partial" : "success",
        detail: notFound.length ? `Not found: ${idList(notFound)}` : null,
        responseStatus: 200,
      });

      return { updated, notFound };
    },
  );

  app.post<{ Body: { tenantId?: string; ids?: string[] } }>(
    "/api/script-catalog/bulk-delete",
    { preHandler: requirePermission("catalog:write") },
    async (req, reply) => {
      const { tenantId, ids } = req.body ?? {};
      if (!tenantId?.trim()) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }
      const trimmedTenant = tenantId.trim();

      if (config.DEMO_MODE) {
        const deletedIds: string[] = [];
        const deletedNames: string[] = [];
        for (let i = demoScripts.length - 1; i >= 0; i--) {
          const entry = demoScripts[i];
          if (entry && ids.includes(entry.id) && demoVisibleTo(entry, trimmedTenant)) {
            deletedIds.push(entry.id);
            deletedNames.push(entry.name);
            demoScripts.splice(i, 1);
          }
        }
        const notFound = ids.filter((id) => !deletedIds.includes(id));
        await audit({
          engineer: req.session.engineer!.upn,
          tenantId: trimmedTenant,
          endpoint: "/api/script-catalog/bulk-delete",
          method: "POST",
          action: "script:bulk-delete",
          resourceType: "script",
          summary: `Permanently deleted ${deletedIds.length} of ${ids.length} scripts`,
          detail: [
            deletedNames.length ? `Deleted: ${idList(deletedNames)}` : null,
            notFound.length ? `Not found: ${idList(notFound)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          outcome: notFound.length ? "partial" : "success",
          responseStatus: 200,
        });
        return { deleted: deletedIds, notFound };
      }

      const rows = await db
        .delete(tables.scriptCatalog)
        .where(and(inArray(tables.scriptCatalog.id, ids), visibleTo(trimmedTenant)))
        .returning();
      const deleted = rows.map((r) => r.id);
      const notFound = ids.filter((id) => !deleted.includes(id));

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: trimmedTenant,
        endpoint: "/api/script-catalog/bulk-delete",
        method: "POST",
        action: "script:bulk-delete",
        resourceType: "script",
        summary: `Permanently deleted ${deleted.length} of ${ids.length} scripts`,
        detail: [
          rows.length ? `Deleted: ${idList(rows.map((r) => r.name))}` : null,
          notFound.length ? `Not found: ${idList(notFound)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        outcome: notFound.length ? "partial" : "success",
        responseStatus: 200,
      });

      return { deleted, notFound };
    },
  );
}
