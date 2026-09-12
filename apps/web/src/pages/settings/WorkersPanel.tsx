import { useQuery } from "@tanstack/react-query";
import { api, type ServerHealthJobsSummary, type ServerHealthQueues } from "../../lib/api";
import { Card, KpiCard } from "../../components/ui";

const POLL_INTERVAL_MS = 5_000;

const QUEUE_LABELS: Record<string, string> = {
  remediation: "Remediation",
  schedules: "Schedules",
  reports: "Reports",
};

function WorkerLivenessPill({ workers }: { workers: number | null }) {
  if (workers === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">
        N/A
      </span>
    );
  }
  const alive = workers > 0;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        alive
          ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
          : "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400"
      }`}
    >
      {alive ? `${workers} live` : "No workers"}
    </span>
  );
}

/**
 * Settings > Server Health > Workers — BullMQ queue depth, worker-process
 * liveness, and the stuck-jobs tile. Read-only: restarting the api or worker
 * used to be a dedicated action here (self-`process.exit()`, relying on
 * Docker's restart policy to bring it back), but that's the same end result
 * as the Containers tab's queued/audited restart-container for the "api" and
 * "worker" targets — removed to leave one consistent, tracked restart path
 * instead of two.
 */
export function WorkersPanel() {
  const { data: queues, isLoading: queuesLoading, error: queuesError } = useQuery({
    queryKey: ["server-health", "queues"],
    queryFn: () => api.get<ServerHealthQueues>("/api/server-health/queues"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const { data: jobsSummary } = useQuery({
    queryKey: ["server-health", "jobs-summary"],
    queryFn: () => api.get<ServerHealthJobsSummary>("/api/server-health/jobs-summary"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  if (queuesLoading && !queues) {
    return (
      <Card>
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (queuesError || !queues) {
    return (
      <Card>
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load queue status.</p>
      </Card>
    );
  }

  return (
    <div>
      {queues.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: no real BullMQ connection is dialled — queue counts and worker liveness below
          are placeholders.
        </div>
      )}

      {jobsSummary && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <KpiCard
            label="Stuck jobs"
            value={jobsSummary.stuckCount}
            hint="Running or queued past the timeout apps/worker enforces"
            tone={jobsSummary.stuckCount > 0 ? "warn" : "good"}
          />
        </div>
      )}

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <th className="px-5 py-3">Queue</th>
              <th className="px-5 py-3">Waiting</th>
              <th className="px-5 py-3">Active</th>
              <th className="px-5 py-3">Delayed</th>
              <th className="px-5 py-3">Failed</th>
              <th className="px-5 py-3">Workers</th>
            </tr>
          </thead>
          <tbody>
            {queues.queues.map((q) => (
              <tr key={q.name} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                <td className="px-5 py-3 font-medium text-slate-800 dark:text-slate-100">
                  {QUEUE_LABELS[q.name] ?? q.name}
                </td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{q.counts.waiting ?? 0}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{q.counts.active ?? 0}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{q.counts.delayed ?? 0}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{q.counts.failed ?? 0}</td>
                <td className="px-5 py-3">
                  <WorkerLivenessPill workers={q.workers} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
