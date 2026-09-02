import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
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
 * DEMO_MODE never queries Postgres (see config.ts); scripts are read-only
 * there, same as the winget/chocolatey catalog overrides.
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
      if (config.DEMO_MODE) return [];
      const tenantId = req.query.tenantId?.trim();
      // Required, not optional: an absent tenantId used to fall through to an
      // undefined where clause, which returned every tenant's scripts.
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      const includeArchived = req.query.includeArchived === "true";
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
    if (config.DEMO_MODE) {
      return reply.code(409).send({ error: "script catalog is read-only in demo mode" });
    }
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
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "script catalog is read-only in demo mode" });
      }
      const tenantId = req.body?.tenantId?.trim();
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      const archived = req.body?.archived !== false;
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
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "script catalog is read-only in demo mode" });
      }
      const tenantId = req.query.tenantId?.trim();
      if (!tenantId) {
        return reply.code(400).send({ error: "tenantId is required" });
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
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "script catalog is read-only in demo mode" });
      }
      const { tenantId, ids, archived = true } = req.body ?? {};
      if (!tenantId?.trim()) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }
      const rows = await db
        .update(tables.scriptCatalog)
        .set({ archivedAt: archived ? new Date() : null })
        .where(and(inArray(tables.scriptCatalog.id, ids), visibleTo(tenantId.trim())))
        .returning();
      const updated = rows.map((r) => r.id);
      const notFound = ids.filter((id) => !updated.includes(id));

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: tenantId.trim(),
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
      if (config.DEMO_MODE) {
        return reply.code(409).send({ error: "script catalog is read-only in demo mode" });
      }
      const { tenantId, ids } = req.body ?? {};
      if (!tenantId?.trim()) {
        return reply.code(400).send({ error: "tenantId is required" });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: "ids must be a non-empty array" });
      }
      const rows = await db
        .delete(tables.scriptCatalog)
        .where(and(inArray(tables.scriptCatalog.id, ids), visibleTo(tenantId.trim())))
        .returning();
      const deleted = rows.map((r) => r.id);
      const notFound = ids.filter((id) => !deleted.includes(id));

      await audit({
        engineer: req.session.engineer!.upn,
        tenantId: tenantId.trim(),
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
