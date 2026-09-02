import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@patchpilot/db";
import { config } from "../config.js";
import { pingSessionRedis } from "../session-store.js";
import { audit, graphGet, type GraphHost } from "@patchpilot/graph";
import { GRAPH_SCOPES, DEFENDER_SCOPES, PARTNER_CENTER_SCOPES } from "@patchpilot/shared";

/**
 * Connection Status backend.
 *
 * `GET /api/connections` returns the configured Microsoft API surfaces plus the
 * cached result of the most recent "Test connection" run. `POST
 * /api/connections/test` runs real read-only probes against the MSP **home
 * tenant** — including the GDAP delegation read that proves cross-tenant
 * onboarding works — and every probe is audited via `graphGet`. DEMO_MODE
 * simulates the probes — no Microsoft calls — while still writing audit records
 * so the flow is faithful.
 */

type ProbeStatus = "connected" | "mocked" | "unknown" | "error";

interface ProbeSpec {
  name: string;
  scopes: readonly string[];
  /** A cheap read-only endpoint that proves the surface answers. */
  host: GraphHost;
  path: string;
  /**
   * Whether this surface has a cheap read-only probe. Surfaces left unprobed
   * stay "unknown" rather than faking a result we can't actually obtain.
   */
  probeable: boolean;
  /** Why a surface is unprobed, shown in the UI. */
  note?: string;
}

const PROBE_SPECS: ProbeSpec[] = [
  {
    name: "Microsoft Graph",
    scopes: GRAPH_SCOPES,
    host: "graph",
    path: "/organization?$select=id,displayName",
    probeable: true,
  },
  {
    name: "Microsoft Defender",
    scopes: DEFENDER_SCOPES,
    host: "defender",
    path: "/vulnerabilities?$top=1",
    probeable: true,
  },
  {
    name: "Intune",
    scopes: GRAPH_SCOPES.filter((s) => s.startsWith("DeviceManagement")),
    host: "graph",
    path: "/deviceManagement/managedDevices?$top=1",
    probeable: true,
  },
  {
    // GDAP delegation is read from Graph (delegatedAdminRelationships); the
    // Partner Center scope is requested for the broader partner surface but the
    // relationship read is what proves cross-tenant onboarding works.
    name: "Partner Center (GDAP)",
    scopes: [...PARTNER_CENTER_SCOPES, "DelegatedAdminRelationship.Read.All"],
    host: "graph",
    path: "/tenantRelationships/delegatedAdminRelationships?$top=1",
    probeable: true,
  },
];

interface ProbeResult {
  status: ProbeStatus;
  lastSuccessfulCall: string | null;
  latencyMs: number | null;
  detail: string;
}

/** Last test-run result per surface, keyed by surface name. Process-local. */
const lastResults = new Map<string, ProbeResult>();

function view(spec: ProbeSpec) {
  const cached = lastResults.get(spec.name);
  return {
    name: spec.name,
    scopes: spec.scopes,
    status: cached?.status ?? "unknown",
    lastSuccessfulCall: cached?.lastSuccessfulCall ?? null,
    latencyMs: cached?.latencyMs ?? null,
    detail:
      cached?.detail ??
      (spec.probeable
        ? "No probe run yet — click Test connection."
        : (spec.note ?? "Not probeable in this phase.")),
  };
}

export async function statusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async (_req, reply) => {
    // DEMO_MODE serves everything from in-memory fixtures (see server.ts) —
    // no DB or Redis connection exists to check, so a bare liveness reply is
    // the honest answer, same as before this route had real readiness checks.
    if (config.DEMO_MODE) return { ok: true, demoMode: true };

    const [dbOk, redisOk] = await Promise.all([
      db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      pingSessionRedis(),
    ]);
    const ok = dbOk && redisOk;
    if (!ok) reply.code(503);
    return { ok, demoMode: false, checks: { db: dbOk ? "ok" : "error", redis: redisOk ? "ok" : "error" } };
  });

  app.get("/api/connections", async (req, reply) => {
    if (!req.session.engineer) return reply.code(401).send({ error: "unauthenticated" });
    return PROBE_SPECS.map(view);
  });

  app.post("/api/connections/test", async (req, reply) => {
    const engineer = req.session.engineer;
    if (!engineer) return reply.code(401).send({ error: "unauthenticated" });

    const now = new Date().toISOString();

    for (const spec of PROBE_SPECS) {
      // Unprobeable surfaces stay "unknown" — we don't fake a result we can't get.
      if (!spec.probeable) {
        lastResults.set(spec.name, {
          status: "unknown",
          lastSuccessfulCall: lastResults.get(spec.name)?.lastSuccessfulCall ?? null,
          latencyMs: null,
          detail: spec.note ?? "Not probeable in this phase.",
        });
        continue;
      }

      if (config.DEMO_MODE) {
        // Simulate a healthy probe. Still audited so the audit trail is honest
        // about a (simulated) read having been performed.
        const latencyMs = 40 + Math.floor(Math.random() * 60);
        await audit({
          engineer: engineer.upn,
          tenantId: engineer.homeTenantId,
          endpoint: `${spec.host}:${spec.path}`,
          method: "GET",
          // Pinned to api_call so a simulated probe sits alongside the real
          // graphGet-audited ones rather than posing as a domain action.
          category: "api_call",
          resourceType: "connection",
          resourceLabel: spec.name,
          outcome: "success",
          responseStatus: 200,
          latencyMs,
        });
        lastResults.set(spec.name, {
          status: "mocked",
          lastSuccessfulCall: now,
          latencyMs,
          detail: "Simulated probe (DEMO_MODE).",
        });
        continue;
      }

      // Live: real read-only probe against the home tenant. graphGet audits.
      try {
        const res = await graphGet({
          engineer: engineer.upn,
          homeTenantId: engineer.homeTenantId,
          tenantId: engineer.homeTenantId,
          host: spec.host,
          path: spec.path,
        });
        lastResults.set(spec.name, {
          status: res.ok ? "connected" : "error",
          lastSuccessfulCall: res.ok ? now : (lastResults.get(spec.name)?.lastSuccessfulCall ?? null),
          latencyMs: res.latencyMs,
          detail: res.ok ? `HTTP ${res.status} in ${res.latencyMs}ms` : `HTTP ${res.status}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "probe failed";
        lastResults.set(spec.name, {
          status: "error",
          lastSuccessfulCall: lastResults.get(spec.name)?.lastSuccessfulCall ?? null,
          latencyMs: null,
          detail: message,
        });
      }
    }

    // One action row for the click. The per-probe rows above (and graphGet's own)
    // are api_call traffic; this is the decision that triggered them.
    const results = PROBE_SPECS.map(view);
    const failed = results.filter((r) => r.status === "error");
    await audit({
      engineer: engineer.upn,
      tenantId: engineer.homeTenantId,
      endpoint: "/api/connections/test",
      method: "POST",
      action: "connection:test",
      resourceType: "connection",
      summary: `Tested ${results.length} connections — ${failed.length} failing`,
      outcome: failed.length ? "partial" : "success",
      detail: failed.length ? `Failing: ${failed.map((r) => r.name).join(", ")}` : null,
      responseStatus: 200,
    });

    return results;
  });
}
