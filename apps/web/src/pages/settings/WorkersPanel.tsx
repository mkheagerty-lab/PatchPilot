import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type ServerHealthJobsSummary,
  type ServerHealthQueues,
} from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, KpiCard } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";

const POLL_INTERVAL_MS = 5_000;

const QUEUE_LABELS: Record<string, string> = {
  remediation: "Remediation",
  schedules: "Schedules",
  reports: "Reports",
};

/** apps/worker/src/index.ts's DEMO_MODE 503 message, mirrored client-side —
 *  same convention `describeTriggerError` uses in Updates.tsx. */
function describeRestartError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    if (code === "demo_unsupported") {
      return "Restarting a process needs a real process manager — not available in demo mode.";
    }
    return err.message;
  }
  return "Could not restart the process.";
}

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
 * liveness, the stuck-jobs tile, and the two confirmed restart actions.
 *
 * Restarting the api self-restarts the process serving this very request
 * (see restart-after-reply.ts) — the POST still resolves normally first, so
 * closing the dialog on success is correct; a brief connection blip is
 * expected right after, same as Updates.tsx's own apply-update note.
 * Restarting the worker just publishes a Redis message and replies
 * immediately; the api process itself is untouched.
 */
export function WorkersPanel() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [confirmTarget, setConfirmTarget] = useState<"api" | "worker" | null>(null);

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

  const restartApiMutation = useMutation({
    mutationFn: () => api.post("/api/server-health/restart-api", {}),
    onSuccess: () => setConfirmTarget(null),
  });

  const restartWorkerMutation = useMutation({
    mutationFn: () => api.post("/api/server-health/restart-worker", {}),
    onSuccess: () => {
      setConfirmTarget(null);
      void qc.invalidateQueries({ queryKey: ["server-health", "queues"] });
    },
  });

  const activeMutation = confirmTarget === "api" ? restartApiMutation : restartWorkerMutation;

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
          are placeholders, and restart actions are unavailable.
        </div>
      )}

      {!canWrite && (
        <div className="mb-4 max-w-lg rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Your role doesn't include settings write access — restart actions are hidden.
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

      {canWrite && (
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirmTarget("api")}
            className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-white dark:bg-slate-900 px-3.5 py-2 text-sm font-medium text-rose-600 dark:text-rose-400 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
          >
            Restart API
          </button>
          <button
            type="button"
            onClick={() => setConfirmTarget("worker")}
            className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-white dark:bg-slate-900 px-3.5 py-2 text-sm font-medium text-rose-600 dark:text-rose-400 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
          >
            Restart Worker
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        tone="destructive"
        title={confirmTarget === "api" ? "Restart the API?" : "Restart the Worker?"}
        description={
          confirmTarget === "api" ? (
            <>
              This process (serving the page you're looking at right now) will exit and be
              respawned by Docker Compose — a few seconds of downtime. Any in-flight request,
              including this one, may see a brief connection error.
            </>
          ) : (
            <>
              The worker process will exit and be respawned by Docker Compose. Any remediation job
              it's currently running will be interrupted; queued jobs are unaffected and resume once
              it's back.
            </>
          )
        }
        confirmLabel={confirmTarget === "api" ? "Restart API" : "Restart Worker"}
        pendingLabel="Restarting…"
        pending={activeMutation.isPending}
        error={activeMutation.isError ? describeRestartError(activeMutation.error) : null}
        onConfirm={() => activeMutation.mutate()}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
