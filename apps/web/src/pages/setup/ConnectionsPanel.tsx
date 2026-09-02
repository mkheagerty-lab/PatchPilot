import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Card } from "../../components/ui";

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

export function ConnectionsPanel() {
  const queryClient = useQueryClient();

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.get<ConnectionRow[]>("/api/connections"),
  });

  const test = useMutation({
    mutationFn: () => api.post<ConnectionRow[]>("/api/connections/test", {}),
    onSuccess: (rows) => queryClient.setQueryData(["connections"], rows),
  });

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
          connections.map((c) => (
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
              <div className="mt-3 flex flex-wrap gap-1.5">
                {c.scopes.map((s) => (
                  <span
                    key={s}
                    className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                  >
                    {s}
                  </span>
                ))}
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
          ))
        )}
      </div>
    </div>
  );
}
