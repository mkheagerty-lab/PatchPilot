import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type OnboardingReport } from "../../lib/api";
import { GRAPH_WRITE_GATED_SCOPES, DEFENDER_WRITE_GATED_SCOPES } from "@patchpilot/shared";
import { Card } from "../../components/ui";
import { ScopeList, type ScopeStatus } from "../../components/ScopeList";

interface ConnectionRow {
  name: string;
  scopes: string[];
  status: "connected" | "mocked" | "unknown" | "error";
  lastSuccessfulCall: string | null;
  latencyMs: number | null;
  detail: string;
}

const STATUS_STYLES: Record<string, string> = {
  connected: "bg-emerald-100 text-emerald-700",
  mocked: "bg-slate-100 text-slate-600",
  unknown: "bg-amber-100 text-amber-700",
  error: "bg-rose-100 text-rose-700",
};

type ScopeResource = "graph" | "defender" | "partnerCenter";

// Each probed surface (status.ts's PROBE_SPECS) maps onto one of the three
// resources /api/onboarding tracks live scope status for, so the same
// scope-level status/write-gating data ScopeList uses on the App
// Registration page also applies here — Intune shares Graph's service
// principal (its scopes are just the DeviceManagement* subset of
// GRAPH_SCOPES), and "Partner Center (GDAP)" is the partnerCenter resource
// plus one extra Graph-hosted scope that predates a live status lookup.
const RESOURCE_BY_CONNECTION: Record<string, ScopeResource> = {
  "Microsoft Graph": "graph",
  "Microsoft Defender": "defender",
  Intune: "graph",
  "Partner Center (GDAP)": "partnerCenter",
};

const WRITE_GATED_BY_RESOURCE: Record<ScopeResource, readonly string[]> = {
  graph: GRAPH_WRITE_GATED_SCOPES,
  defender: DEFENDER_WRITE_GATED_SCOPES,
  partnerCenter: [],
};

export function ConnectionsPanel() {
  const queryClient = useQueryClient();

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.get<ConnectionRow[]>("/api/connections"),
  });

  // Same source as the App Registration page's permission pills — reused
  // here (not re-probed) so both surfaces agree on one "Test Connection"
  // result instead of running two different checks that could disagree.
  const { data: report } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });

  const test = useMutation({
    mutationFn: () => api.post<ConnectionRow[]>("/api/connections/test", {}),
    onSuccess: (rows) => queryClient.setQueryData(["connections"], rows),
  });

  const statusMap = new Map(
    (report?.scopeStatus?.results ?? []).map((r) => [`${r.resource}:${r.scope}`, r.status]),
  );
  const statusFor = (resource: string, scope: string): ScopeStatus | undefined =>
    statusMap.get(`${resource}:${scope}`);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-slate-500">
          Microsoft API surfaces PatchPilot talks to. Probes are read-only and
          run against the MSP home tenant; each one is audited.
        </p>
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {test.isPending ? "Testing…" : "Test connection"}
        </button>
      </div>

      {test.isError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {(test.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {isLoading ? (
          <Card>
            <p className="text-sm text-slate-500">Loading…</p>
          </Card>
        ) : (
          connections.map((c) => {
            const resource = RESOURCE_BY_CONNECTION[c.name];
            // Same "not found on the resource's service principal" banner as
            // App Registration's Get Started > Step 3 — filtered to just
            // this card's own scopes, since each connection surfaces its own
            // failures rather than one combined list.
            const failedScopes = resource
              ? c.scopes.filter((s) => statusFor(resource, s) === "failed")
              : [];

            return (
              <Card key={c.name}>
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-semibold text-slate-800">
                    {c.name}
                  </h3>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                      STATUS_STYLES[c.status] ?? STATUS_STYLES.unknown
                    }`}
                  >
                    {c.status}
                  </span>
                </div>

                {failedScopes.length > 0 && (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    <span className="font-medium">{c.name}:</span> {failedScopes.length} permission
                    {failedScopes.length === 1 ? "" : "s"} not found on the resource —{" "}
                    {failedScopes.join(", ")}.
                  </div>
                )}

                <div className="mt-3">
                  <ScopeList
                    title="Requested permissions"
                    scopes={c.scopes}
                    resource={resource}
                    statusFor={report && !report.demoMode ? statusFor : undefined}
                    writeGatedScopes={resource ? WRITE_GATED_BY_RESOURCE[resource] : undefined}
                  />
                </div>

                <div className="mt-3 text-xs text-slate-500">{c.detail}</div>
                <div className="mt-1 text-xs text-slate-400">
                  {c.lastSuccessfulCall
                    ? `Last OK: ${new Date(c.lastSuccessfulCall).toLocaleString()}${
                        c.latencyMs != null ? ` · ${c.latencyMs}ms` : ""
                      }`
                    : "No probe run yet"}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
