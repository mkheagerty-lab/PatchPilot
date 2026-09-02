import { z } from "zod";
import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { can, type Permission } from "@patchpilot/shared";
import { config } from "../config.js";
import { loadTenantPosture, severityCounts, slaCounts, complianceCounts, type PostureFinding } from "../posture/findings.js";
import { loadSlaThresholds } from "../routes/recommendations.js";
import { listJobs } from "../jobs.js";
import { fetchRemediationHistory } from "../history/remediation-history.js";
import { loadReachableTenants, ToolError, type ToolContext } from "./context.js";

/**
 * The model's entire surface onto PatchPilot's data: six fixed, named,
 * typed functions. Nothing here takes a query string or a DB handle — each
 * tool independently re-checks the requesting engineer's role permission
 * (the exact same `can()` check `requirePermission()` uses) and, for
 * anything tenant-scoped, that the tenant is in `ctx.reachableTenantIds`
 * (the exact same set the tenant switcher offers). A tool can only ever
 * return what the corresponding page/API route would already have shown
 * this engineer — it composes and narrates, it cannot originate a query the
 * rest of the app doesn't already expose.
 */
export interface ToolDefinition<Args> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  schema: z.ZodType<Args>;
  run: (ctx: ToolContext, args: Args) => Promise<unknown>;
}

function requirePermissionOrThrow(ctx: ToolContext, permission: Permission): void {
  if (!can(ctx.user.role, permission)) {
    throw new ToolError(`You don't have permission to view that (requires "${permission}").`);
  }
}

function requireReachableTenant(ctx: ToolContext, tenantId: string): void {
  if (!ctx.reachableTenantIds.has(tenantId)) {
    throw new ToolError(`Tenant "${tenantId}" is not reachable — it's unknown or not currently consented.`);
  }
}

const SEVERITY_RANK: Record<PostureFinding["severity"], number> = { critical: 4, high: 3, medium: 2, low: 1 };
const TONE_RANK: Record<PostureFinding["tone"], number> = { breached: 3, "due-soon": 2, ok: 1 };

// ---- 1. list_reachable_tenants ----

const listReachableTenantsTool: ToolDefinition<Record<string, never>> = {
  name: "list_reachable_tenants",
  description:
    "List the MSP customer tenants the current engineer can currently reach in PatchPilot, with display name and reachability status. Call this first when a question names a customer by name rather than tenant ID, or asks something cross-tenant like \"which tenants\" or \"across all customers\".",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: z.object({}).strict(),
  async run(_ctx) {
    const tenants = await loadReachableTenants();
    return {
      tenants: tenants.map((t) => ({ tenantId: t.tenantId, displayName: t.displayName })),
    };
  },
};

// ---- 2. get_tenant_posture_summary ----

const tenantPostureArgs = z.object({ tenantId: z.string().min(1) }).strict();

const getTenantPostureSummaryTool: ToolDefinition<z.infer<typeof tenantPostureArgs>> = {
  name: "get_tenant_posture_summary",
  description:
    "Get one tenant's current security posture: device count, open finding count, findings by severity, findings by SLA status (breached / due-soon / ok), and devices by compliance state. Use for \"how is <tenant> doing\" style questions.",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string", description: "The tenant's Entra tenant GUID (from list_reachable_tenants)." },
    },
    required: ["tenantId"],
    additionalProperties: false,
  },
  schema: tenantPostureArgs,
  async run(ctx, args) {
    requirePermissionOrThrow(ctx, "operations:read");
    requireReachableTenant(ctx, args.tenantId);

    const thresholds = await loadSlaThresholds();
    const posture = await loadTenantPosture(args.tenantId, thresholds);
    return {
      tenantId: args.tenantId,
      deviceCount: posture.devices.length,
      findingCount: posture.findings.length,
      severityCounts: severityCounts(posture.findings),
      slaCounts: slaCounts(posture.findings),
      complianceCounts: complianceCounts(posture.devices),
      exceptedFindings: posture.exceptedFindings,
      excludedDevices: posture.excludedDevices,
    };
  },
};

// ---- 3. get_top_vulnerabilities ----

const topVulnsArgs = z
  .object({ tenantId: z.string().min(1), limit: z.number().int().min(1).max(25).optional() })
  .strict();

const getTopVulnerabilitiesTool: ToolDefinition<z.infer<typeof topVulnsArgs>> = {
  name: "get_top_vulnerabilities",
  description:
    "Get the most urgent open findings for one tenant, ranked by severity then SLA status then affected device count. Use for \"what should we fix first\" or \"what's critical right now\" style questions.",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string", description: "The tenant's Entra tenant GUID." },
      limit: { type: "number", description: "Max rows to return, default 10, max 25." },
    },
    required: ["tenantId"],
    additionalProperties: false,
  },
  schema: topVulnsArgs,
  async run(ctx, args) {
    requirePermissionOrThrow(ctx, "operations:read");
    requireReachableTenant(ctx, args.tenantId);

    const thresholds = await loadSlaThresholds();
    const posture = await loadTenantPosture(args.tenantId, thresholds);
    const limit = args.limit ?? 10;
    const ranked = [...posture.findings].sort((a, b) => {
      const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (bySeverity !== 0) return bySeverity;
      const byTone = TONE_RANK[b.tone] - TONE_RANK[a.tone];
      if (byTone !== 0) return byTone;
      return b.affectedDeviceCount - a.affectedDeviceCount;
    });
    return {
      tenantId: args.tenantId,
      findings: ranked.slice(0, limit).map((f) => ({
        cveId: f.cveId,
        title: f.title,
        software: f.software,
        severity: f.severity,
        slaStatus: f.tone,
        affectedDeviceCount: f.affectedDeviceCount,
      })),
    };
  },
};

// ---- 4. get_remediation_history ----

const remediationHistoryArgs = z
  .object({
    tenantId: z.string().min(1).optional(),
    cveId: z.string().min(1).optional(),
    software: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const getRemediationHistoryTool: ToolDefinition<z.infer<typeof remediationHistoryArgs>> = {
  name: "get_remediation_history",
  description:
    "Look up previously closed findings (what was remediated, when, how and by whom). Filter by tenant, CVE ID and/or software name. Omit tenantId to search across every tenant the engineer can reach.",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string", description: "Optional: restrict to one tenant's Entra tenant GUID." },
      cveId: { type: "string", description: "Optional: exact CVE ID, e.g. CVE-2024-12345." },
      software: { type: "string", description: "Optional: software name to filter on." },
      limit: { type: "number", description: "Max rows to return, default 10, max 50." },
    },
    additionalProperties: false,
  },
  schema: remediationHistoryArgs,
  async run(ctx, args) {
    requirePermissionOrThrow(ctx, "operations:read");
    const limit = args.limit ?? 10;

    if (args.tenantId) {
      requireReachableTenant(ctx, args.tenantId);
      const rows = await fetchRemediationHistory(
        { tenantId: args.tenantId, cveId: args.cveId, software: args.software },
        limit,
      );
      return { rows: rows.map(shapeRemediationRow) };
    }

    // No tenant given: constrain at the query level to this engineer's
    // reachable tenants, same pattern as search_script_catalog's inArray scope.
    const rows = await fetchRemediationHistory(
      { cveId: args.cveId, software: args.software, tenantIds: [...ctx.reachableTenantIds] },
      limit,
    );
    return { rows: rows.map(shapeRemediationRow) };
  },
};

function shapeRemediationRow(r: Awaited<ReturnType<typeof fetchRemediationHistory>>[number]) {
  return {
    tenantId: r.tenantId,
    cveId: r.cveId,
    software: r.software,
    severity: r.severity,
    remediatedAt: r.remediatedAt,
    deviceHostname: r.deviceHostname,
    engineer: r.engineer,
    attribution: r.attribution,
  };
}

// ---- 5. get_recent_jobs ----

const recentJobsArgs = z
  .object({ tenantId: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).optional() })
  .strict();

const getRecentJobsTool: ToolDefinition<z.infer<typeof recentJobsArgs>> = {
  name: "get_recent_jobs",
  description:
    "List recent remediation jobs (dispatched fixes) and their status — queued, running, succeeded or failed. Omit tenantId to search across every tenant the engineer can reach.",
  parameters: {
    type: "object",
    properties: {
      tenantId: { type: "string", description: "Optional: restrict to one tenant's Entra tenant GUID." },
      limit: { type: "number", description: "Max rows to return, default 10, max 50." },
    },
    additionalProperties: false,
  },
  schema: recentJobsArgs,
  async run(ctx, args) {
    requirePermissionOrThrow(ctx, "operations:read");
    const limit = args.limit ?? 10;

    if (args.tenantId) {
      requireReachableTenant(ctx, args.tenantId);
      const jobs = await listJobs(args.tenantId, false);
      return { jobs: jobs.slice(0, limit).map(shapeJobRow) };
    }

    const jobs = await listJobs(undefined, false, [...ctx.reachableTenantIds]);
    return { jobs: jobs.slice(0, limit).map(shapeJobRow) };
  },
};

function shapeJobRow(j: Awaited<ReturnType<typeof listJobs>>[number]) {
  return {
    tenantId: j.tenantId,
    deviceHostname: j.deviceHostname,
    software: j.software,
    cveId: j.cveId,
    status: j.status,
    engineer: j.engineer,
    queuedAt: j.queuedAt,
    finishedAt: j.finishedAt,
  };
}

// ---- 6. search_script_catalog ----

const searchCatalogArgs = z
  .object({
    query: z.string().min(1).optional(),
    tenantId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  })
  .strict();

const searchScriptCatalogTool: ToolDefinition<z.infer<typeof searchCatalogArgs>> = {
  name: "search_script_catalog",
  description:
    "Search the uploaded remediation script catalog by name/description. Omit tenantId to include global scripts plus every tenant-specific script the engineer can reach.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Optional free-text search over script name and description." },
      tenantId: { type: "string", description: "Optional: restrict to one tenant's scripts (plus global ones)." },
      limit: { type: "number", description: "Max rows to return, default 10, max 25." },
    },
    additionalProperties: false,
  },
  schema: searchCatalogArgs,
  async run(ctx, args) {
    requirePermissionOrThrow(ctx, "catalog:read");
    if (args.tenantId) requireReachableTenant(ctx, args.tenantId);
    if (config.DEMO_MODE) return { scripts: [] };

    const limit = args.limit ?? 10;
    const scopeCondition = args.tenantId
      ? or(eq(tables.scriptCatalog.tenantId, args.tenantId), isNull(tables.scriptCatalog.tenantId))!
      : or(isNull(tables.scriptCatalog.tenantId), inArray(tables.scriptCatalog.tenantId, [...ctx.reachableTenantIds]))!;
    const conditions = [scopeCondition, isNull(tables.scriptCatalog.archivedAt)];
    if (args.query) {
      const like = `%${args.query}%`;
      conditions.push(or(ilike(tables.scriptCatalog.name, like), ilike(tables.scriptCatalog.description, like))!);
    }

    const rows = await db
      .select()
      .from(tables.scriptCatalog)
      .where(and(...conditions))
      .limit(limit);

    return {
      scripts: rows.map((s) => ({
        name: s.name,
        description: s.description,
        scriptType: s.scriptType,
        tenantId: s.tenantId,
      })),
    };
  },
};

export const TOOLS: ToolDefinition<any>[] = [
  listReachableTenantsTool,
  getTenantPostureSummaryTool,
  getTopVulnerabilitiesTool,
  getRemediationHistoryTool,
  getRecentJobsTool,
  searchScriptCatalogTool,
];
