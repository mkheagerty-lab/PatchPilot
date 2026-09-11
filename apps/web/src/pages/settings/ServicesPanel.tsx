import { useQuery } from "@tanstack/react-query";
import { api, type ServerHealthServices } from "../../lib/api";
import { Card } from "../../components/ui";

const POLL_INTERVAL_MS = 5_000;

function StatusPill({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        ok
          ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400"
      }`}
    >
      {ok ? "Reachable" : "Unreachable"}
    </span>
  );
}

/** Settings > Server Health > Services — reuses the same DB/Redis probes
 *  `/api/health` runs (see status.ts), just timed and gathered here instead
 *  of folded into that unauthenticated liveness endpoint. */
export function ServicesPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["server-health", "services"],
    queryFn: () => api.get<ServerHealthServices>("/api/server-health/services"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (isLoading && !data) {
    return (
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load service status.</p>
      </Card>
    );
  }

  return (
    <div>
      {data.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: no real Postgres/Redis connection is dialled — these are placeholder readings.
        </div>
      )}
      <Card className="max-w-lg p-0">
        <ul>
          <li className="flex items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">PostgreSQL</div>
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {data.database.latencyMs !== null ? `${data.database.latencyMs} ms` : "—"}
              </div>
            </div>
            <StatusPill ok={data.database.ok} />
          </li>
          <li className="flex items-center justify-between gap-4 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">Redis</div>
              <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {data.redis.latencyMs !== null ? `${data.redis.latencyMs} ms` : "—"}
              </div>
            </div>
            <StatusPill ok={data.redis.ok} />
          </li>
        </ul>
      </Card>
    </div>
  );
}
