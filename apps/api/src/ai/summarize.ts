import { SEVERITY_RANK, type Severity } from "@patchpilot/shared";
import { getOllamaClient } from "./chat.js";
import { SUMMARIZE_SYSTEM_PROMPT } from "./prompts.js";
import { loadTenantPosture, severityCounts, slaCounts, complianceCounts } from "../posture/findings.js";
import { loadSlaThresholds } from "../routes/recommendations.js";
import {
  fetchRemediationHistory,
  REMEDIATION_HISTORY_MAX_EXPORT_ROWS,
  type RemediationHistoryQuery,
} from "../history/remediation-history.js";
import { buildDashboardSummary } from "../routes/dashboard.js";

/**
 * The single-shot summarize path (`POST /api/ai/summarize`): gather the exact
 * aggregate the target page already renders, then hand it to the model for
 * narration only — no tools, no DB access from the model's side. This is what
 * "never invent numbers" means structurally: the facts are fixed before the
 * model ever runs, and its only job is prose.
 */
export type SummarizePage = "dashboard" | "vulnerabilities" | "devices" | "remediation-history";

export interface SummarizeArgs {
  page: SummarizePage;
  /** null = all reachable tenants. Only "dashboard" and "remediation-history"
   * support this — it mirrors which pages themselves have an all-tenants view. */
  tenantId: string | null;
  windowDays?: number;
  /** Reachable-tenant filter for the all-tenants remediation-history case —
   * same set get_remediation_history (tools.ts) applies when no tenant is given. */
  reachableTenantIds: ReadonlySet<string>;
}

/** Thrown for a request shape that's syntactically valid but doesn't make
 * sense for the page (e.g. no tenant selected for a single-tenant-only page).
 * The route maps this to a 400, not a 502 (that's reserved for Ollama itself). */
export class SummarizeInputError extends Error {}

const DEFAULT_WINDOW_DAYS = 30;

/** Exported for `apps/api/src/reports/facts.ts`, which narrates the same
 * per-tenant posture shape into a printed report — the summarize path and the
 * report path must never describe one tenant from two different aggregates. */
export async function gatherTenantPostureFacts(tenantId: string) {
  const thresholds = await loadSlaThresholds();
  const posture = await loadTenantPosture(tenantId, thresholds);
  const topFindings = [...posture.findings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.affectedDeviceCount - a.affectedDeviceCount)
    .slice(0, 10)
    .map((f) => ({
      cveId: f.cveId,
      software: f.software,
      severity: f.severity,
      slaStatus: f.tone,
      affectedDeviceCount: f.affectedDeviceCount,
    }));

  return {
    tenantId,
    deviceCount: posture.devices.length,
    findingCount: posture.findings.length,
    severityCounts: severityCounts(posture.findings),
    slaCounts: slaCounts(posture.findings),
    complianceCounts: complianceCounts(posture.devices),
    exceptedFindings: posture.exceptedFindings,
    excludedDevices: posture.excludedDevices,
    topFindings,
  };
}

export async function gatherRemediationHistoryFacts(args: SummarizeArgs) {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const from = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const query: RemediationHistoryQuery = args.tenantId
    ? { tenantId: args.tenantId, from }
    : { from, tenantIds: [...args.reachableTenantIds] };

  // Same pattern as get_remediation_history (tools.ts): a tenant-less query
  // is constrained to this engineer's reachable tenants at the query level.
  const rows = await fetchRemediationHistory(query, REMEDIATION_HISTORY_MAX_EXPORT_ROWS);

  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byAttribution: Record<string, number> = {};
  for (const r of rows) {
    bySeverity[r.severity] += 1;
    byAttribution[r.attribution] = (byAttribution[r.attribution] ?? 0) + 1;
  }

  return {
    tenantId: args.tenantId,
    windowDays,
    totalRemediated: rows.length,
    bySeverity,
    byAttribution,
    recent: rows.slice(0, 10).map((r) => ({
      tenantId: r.tenantId,
      cveId: r.cveId,
      software: r.software,
      severity: r.severity,
      remediatedAt: r.remediatedAt,
      engineer: r.engineer,
      attribution: r.attribution,
    })),
  };
}

async function gatherFacts(args: SummarizeArgs): Promise<unknown> {
  switch (args.page) {
    case "dashboard":
      return buildDashboardSummary(args.tenantId ?? undefined, args.windowDays);
    case "vulnerabilities":
    case "devices":
      if (!args.tenantId) {
        throw new SummarizeInputError(`Select a single tenant to summarize the ${args.page} page.`);
      }
      return gatherTenantPostureFacts(args.tenantId);
    case "remediation-history":
      return gatherRemediationHistoryFacts(args);
  }
}

/** Gathers the page's facts, then asks Ollama to narrate them. Returns the
 * narration plus the underlying facts, so the route can audit/log what the
 * model actually saw (never inferred from the prose after the fact). */
export async function summarizePage(args: SummarizeArgs): Promise<{ summary: string; facts: unknown }> {
  const facts = await gatherFacts(args);

  const ollama = getOllamaClient();
  const { message } = await ollama.chat({
    messages: [
      { role: "system", content: SUMMARIZE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Page: ${args.page}\nData (JSON — the only source of truth for any number or name you state):\n${JSON.stringify(facts)}`,
      },
    ],
  });

  return { summary: message.content.trim(), facts };
}
