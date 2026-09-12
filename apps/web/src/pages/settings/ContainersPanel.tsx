import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CONTAINER_INFO, RESTARTABLE_CONTAINERS, type RestartableContainer } from "@patchpilot/shared";
import {
  api,
  ApiError,
  type ServerHealthContainerStat,
  type ServerHealthContainerStats,
  type ServerHealthControlRequest,
  type ServerHealthControlRequests,
} from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";

const POLL_INTERVAL_MS = 3_000;
const STATS_POLL_INTERVAL_MS = 15_000;
const HISTORY_ROWS = 5;

/**
 * "Docker" vs "pnpm" is derived from the data, not hardcoded per container
 * name — in production every RESTARTABLE_CONTAINERS entry runs as a real
 * Docker container, but in local dev api/worker self-report instead (see
 * apps/api/src/self-process-stats.ts). A row with an `image` came from the
 * updater's `docker stats`/`docker inspect` sampling; one without it but with
 * a sample came from self-reporting; no sample at all means we don't know.
 */
function describeRuntime(stat: ServerHealthContainerStat | undefined): string {
  if (!stat || stat.sampledAt === null) return "—";
  return stat.image !== null ? "Docker" : "pnpm";
}

/** Deliberately plain and non-alarming — a container with no data (e.g. one
 *  that only ever runs in production, not in this dev instance) reads as
 *  "unknown", not "down". */
function StatusCell({ stat }: { stat: ServerHealthContainerStat | undefined }) {
  if (!stat || stat.sampledAt === null) {
    return <span className="text-slate-400 dark:text-slate-500">—</span>;
  }
  if (stat.stale) {
    return (
      <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
        Not reporting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Running
    </span>
  );
}

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

  // Runtime/Status columns below — best-effort only, so a failure here never
  // blocks the restart controls above from rendering.
  const { data: statsData } = useQuery({
    queryKey: ["server-health", "container-stats"],
    queryFn: () => api.get<ServerHealthContainerStats>("/api/server-health/container-stats"),
    refetchInterval: STATS_POLL_INTERVAL_MS,
  });
  const statsByContainer = new Map(statsData?.containers.map((s) => [s.container, s] as const));

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

      {/* These requests carry no tenant, so the Audit Log's default tenant-scoped
          view shows none of them — the link forces the aggregate view (see the
          tenant-scoping note on that page) so "View in Audit Log" isn't a
          dead end. */}
      <div className="mb-4">
        <Link
          to="/audit?scope=all&q=server:"
          className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:underline"
        >
          View server restart history in Audit Log →
        </Link>
      </div>

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-100 dark:border-slate-800 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              <th className="px-5 py-3">Container</th>
              <th className="px-5 py-3">Path</th>
              <th className="px-5 py-3">Port</th>
              <th className="px-5 py-3">Runtime</th>
              <th className="px-5 py-3">Status</th>
              {canWrite && <th className="px-5 py-3" />}
            </tr>
          </thead>
          <tbody>
            {RESTARTABLE_CONTAINERS.map((name) => (
              <tr key={name} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                <td className="px-5 py-3 font-medium text-slate-800 dark:text-slate-100">{name}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{CONTAINER_INFO[name].path}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{CONTAINER_INFO[name].port}</td>
                <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{describeRuntime(statsByContainer.get(name))}</td>
                <td className="px-5 py-3">
                  <StatusCell stat={statsByContainer.get(name)} />
                </td>
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
