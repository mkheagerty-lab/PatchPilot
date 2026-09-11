import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RESTARTABLE_CONTAINERS, type RestartableContainer } from "@patchpilot/shared";
import { api, ApiError, type ServerHealthControlRequest, type ServerHealthControlRequests } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";

const POLL_INTERVAL_MS = 3_000;
const HISTORY_ROWS = 5;

/** Restarting the api or worker containers this way (unlike Workers tab's
 *  restart-api/restart-worker) goes through the updater's queue, same as
 *  every other container — no special-casing needed here. */
type ConfirmTarget = { kind: "container"; target: RestartableContainer } | { kind: "stack" };

function describeControlError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    if (code === "demo_unsupported") {
      return "Restarting containers needs the updater sidecar — not available in demo mode.";
    }
    if (code === "control_request_already_pending") {
      return "Another restart request is already queued or running. Wait for it to finish first.";
    }
    if (code === "invalid_target") {
      return "That container can't be restarted from here.";
    }
    return err.message;
  }
  return "Could not queue the restart.";
}

function StatusPill({ status }: { status: ServerHealthControlRequest["status"] }) {
  const styles: Record<ServerHealthControlRequest["status"], string> = {
    queued: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
    running: "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400",
    succeeded: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    failed: "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400",
  };
  const labels: Record<ServerHealthControlRequest["status"], string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function describeTarget(req: ServerHealthControlRequest): string {
  return req.action === "restart-stack" ? "Whole stack" : (req.target ?? "—");
}

/**
 * Settings > Server Health > Containers (Phase 2) — restart an individual
 * infra container, or the whole compose stack, via a `server_control_requests`
 * row the `updater` sidecar polls and executes (see infra/updater/run.sh).
 * Unlike the Workers tab's restart-api/restart-worker (synchronous, this
 * process or a Redis message), these actions are queued and complete
 * asynchronously — this panel polls control-requests to show progress, same
 * "poll until it leaves queued/running" pattern Updates.tsx already uses.
 */
export function ContainersPanel() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["server-health", "control-requests"],
    queryFn: () => api.get<ServerHealthControlRequests>("/api/server-health/control-requests"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["server-health", "control-requests"] });

  const restartContainerMutation = useMutation({
    mutationFn: (target: string) => api.post("/api/server-health/restart-container", { target }),
    onSuccess: () => {
      setConfirmTarget(null);
      invalidate();
    },
  });

  const restartStackMutation = useMutation({
    mutationFn: () => api.post("/api/server-health/restart-stack", {}),
    onSuccess: () => {
      setConfirmTarget(null);
      invalidate();
    },
  });

  const activeMutation = confirmTarget?.kind === "stack" ? restartStackMutation : restartContainerMutation;

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
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load container status.</p>
      </Card>
    );
  }

  return (
    <div>
      {data.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: no updater sidecar is running — restart actions are unavailable.
        </div>
      )}

      {!canWrite && (
        <div className="mb-4 max-w-lg rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Your role doesn't include settings write access — restart actions are hidden.
        </div>
      )}

      {data.pendingRequest && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-3">
          <div className="text-sm text-slate-700 dark:text-slate-300">
            Restart in progress: <span className="font-medium">{describeTarget(data.pendingRequest)}</span>
          </div>
          <StatusPill status={data.pendingRequest.status} />
        </div>
      )}

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <th className="px-5 py-3">Container</th>
              {canWrite && <th className="px-5 py-3" />}
            </tr>
          </thead>
          <tbody>
            {RESTARTABLE_CONTAINERS.map((name) => (
              <tr key={name} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                <td className="px-5 py-3 font-medium text-slate-800 dark:text-slate-100">{name}</td>
                {canWrite && (
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setConfirmTarget({ kind: "container", target: name })}
                      className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-rose-600 dark:text-rose-400 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
                    >
                      Restart
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {canWrite && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setConfirmTarget({ kind: "stack" })}
            className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-white dark:bg-slate-900 px-3.5 py-2 text-sm font-medium text-rose-600 dark:text-rose-400 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10"
          >
            Restart entire stack
          </button>
        </div>
      )}

      {data.history.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            Recent restarts
          </h3>
          <Card className="p-0">
            <ul>
              {data.history.slice(0, HISTORY_ROWS).map((req) => (
                <li
                  key={req.id}
                  className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 px-5 py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {describeTarget(req)}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {req.requestedBy} · {new Date(req.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <StatusPill status={req.status} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        tone="destructive"
        title={
          confirmTarget?.kind === "stack"
            ? "Restart the entire stack?"
            : `Restart ${confirmTarget?.kind === "container" ? confirmTarget.target : ""}?`
        }
        description={
          confirmTarget?.kind === "stack" ? (
            <>
              Every container in the stack (except the updater itself) will restart —
              roughly 10-30 seconds of downtime across the whole app. Queued jobs and
              scheduled runs resume once it's back.
            </>
          ) : (
            <>
              The <span className="font-medium">{confirmTarget?.kind === "container" ? confirmTarget.target : ""}</span>{" "}
              container will restart via the updater sidecar. This is queued, not
              immediate — watch its status below.
            </>
          )
        }
        confirmLabel={confirmTarget?.kind === "stack" ? "Restart stack" : "Restart container"}
        pendingLabel="Queuing…"
        pending={activeMutation.isPending}
        error={activeMutation.isError ? describeControlError(activeMutation.error) : null}
        onConfirm={() => {
          if (!confirmTarget) return;
          if (confirmTarget.kind === "stack") {
            restartStackMutation.mutate();
          } else {
            restartContainerMutation.mutate(confirmTarget.target);
          }
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
