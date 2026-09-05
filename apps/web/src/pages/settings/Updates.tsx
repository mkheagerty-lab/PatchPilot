import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type OnboardingReport, type UpdateRun, type UpdatesSettingsView } from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, PageHeader } from "../../components/ui";
import { DateTimePicker } from "../../components/DateTimePicker";

type WhenMode = "now" | "once";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/** `fromVersion` is stamped from the bare package.json version ("0.1.0"),
 *  while `targetVersion` is a full git tag ("v0.2.0") — normalize so a
 *  "from → to" pair doesn't show one side missing its "v". */
function withV(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

/** Maps the API's `{ error: "<code>" }` bodies to what an admin should read,
 *  instead of the raw machine-readable code `ApiError.message` falls back to. */
function describeTriggerError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    switch (code) {
      case "update_already_pending":
        return "An update is already queued or running.";
      case "no_update_available":
        return "No update is available to run.";
      case "demo_unsupported":
        return "Triggering an update needs a real database — not available in demo mode.";
      case "scheduled_at_must_be_future":
        return "Pick a time in the future.";
      case "already_current":
        return "That's the version already running.";
      case "not_a_known_version":
        return "That version was never successfully run on this instance.";
      default:
        return err.message;
    }
  }
  return "Could not trigger the update.";
}

/**
 * Settings > Updates — checks GitHub Releases for a newer PatchPilot version
 * and hands off "run now" / "schedule" to the `updater` sidecar (see
 * infra/updater/run.sh), which does the actual git-pull + rebuild + restart.
 *
 * Unlike License.tsx, this page stays partly visible in demo mode: the
 * version-status and release-notes cards are a legitimate thing to show in a
 * demo, and only the run/schedule controls — which need a real database and
 * a real updater sidecar — are replaced with an explanatory message.
 */
export function Updates() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  // Confirm-before-acting for rollback, same reasoning as Tenants.tsx's
  // pendingWrite modal: window.confirm() silently no-ops under plenty of
  // ordinary conditions (Chrome's "prevent additional dialogs", automation,
  // an embedding iframe), so this uses a real in-app modal instead.
  const [pendingRollback, setPendingRollback] = useState<UpdateRun | null>(null);

  const { data: report } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.get<OnboardingReport>("/api/onboarding"),
  });
  const demoMode = report?.demoMode ?? false;

  const { data, isLoading } = useQuery({
    queryKey: ["settings", "updates"],
    queryFn: () => api.get<UpdatesSettingsView>("/api/settings/updates"),
    // Keep watching a queued/running run without an engineer having to
    // refresh — same spirit as how report generation is polled.
    refetchInterval: (query) => (query.state.data?.pendingRun ? 5_000 : false),
  });

  const checkMutation = useMutation({
    mutationFn: () => api.post<UpdatesSettingsView>("/api/settings/updates/check", {}),
    onSuccess: (next) => qc.setQueryData(["settings", "updates"], next),
  });

  const runNowMutation = useMutation({
    mutationFn: () => api.post("/api/settings/updates/run-now", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "updates"] }),
  });

  const scheduleMutation = useMutation({
    mutationFn: (at: Date) =>
      api.post("/api/settings/updates/schedule", { scheduledAt: at.toISOString() }),
    onSuccess: () => {
      setScheduleAt(null);
      qc.invalidateQueries({ queryKey: ["settings", "updates"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.del(`/api/settings/updates/runs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings", "updates"] }),
  });

  const rollbackMutation = useMutation({
    mutationFn: (targetVersion: string) =>
      api.post("/api/settings/updates/rollback", { targetVersion }),
    onSuccess: () => {
      setPendingRollback(null);
      qc.invalidateQueries({ queryKey: ["settings", "updates"] });
    },
  });

  const triggerError = runNowMutation.error ?? scheduleMutation.error;
  const triggerPending = runNowMutation.isPending || scheduleMutation.isPending;

  function submitTrigger() {
    if (whenMode === "now") {
      runNowMutation.mutate();
    } else if (scheduleAt) {
      scheduleMutation.mutate(scheduleAt);
    }
  }

  return (
    <div>
      <PageHeader
        title="Updates"
        subtitle="Check for new PatchPilot releases and trigger the self-update sidecar to apply them."
        actions={
          <button
            onClick={() => checkMutation.mutate()}
            disabled={checkMutation.isPending}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {checkMutation.isPending ? "Checking…" : "Check now"}
          </button>
        }
      />

      {isLoading || !data ? (
        <Card>
          <p className="text-sm text-slate-500">Loading…</p>
        </Card>
      ) : (
        <div className="space-y-5">
          <Card className="max-w-lg">
            <div className="mb-3 text-sm font-medium text-slate-700">Version</div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Running</span>
                <span className="font-mono text-slate-700">v{data.currentVersion}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Latest available</span>
                <span
                  className={
                    data.updateAvailable
                      ? "font-mono font-medium text-indigo-600"
                      : "font-mono text-slate-700"
                  }
                >
                  {data.latestVersion ? `v${data.latestVersion}` : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Last checked</span>
                <span className="text-slate-700">{formatDate(data.lastCheckedAt)}</span>
              </div>
            </div>
            {data.updateAvailable && (
              <p className="mt-3 rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
                An update to v{data.latestVersion} is available.
              </p>
            )}
            {checkMutation.isError && (
              <p className="mt-2 text-xs text-rose-600">
                {checkMutation.error instanceof ApiError
                  ? checkMutation.error.message
                  : "Could not check for updates."}
              </p>
            )}
          </Card>

          {data.latestReleaseNotes && (
            <Card className="max-w-lg">
              <div className="mb-2 text-sm font-medium text-slate-700">
                Release notes {data.latestVersion ? `— v${data.latestVersion}` : ""}
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm text-slate-600">
                {data.latestReleaseNotes}
              </pre>
              {data.latestReleaseUrl && (
                <a
                  href={data.latestReleaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs font-medium text-indigo-600 hover:underline"
                >
                  View on GitHub →
                </a>
              )}
            </Card>
          )}

          {!canWrite && (
            <div className="max-w-lg rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Your role doesn't include settings write access.
            </div>
          )}

          {demoMode ? (
            <Card className="max-w-lg">
              <div className="mb-1 text-sm font-medium text-slate-700">Apply update</div>
              <p className="text-sm text-slate-500">
                Triggering an update needs a real database and the `updater` sidecar container —
                not available in demo mode.
              </p>
            </Card>
          ) : (
            data.pendingRun ? (
              <Card className="max-w-lg">
                <div className="mb-3 text-sm font-medium text-slate-700">
                  {data.pendingRun.kind === "rollback"
                    ? data.pendingRun.status === "running"
                      ? "Rollback in progress"
                      : "Rollback scheduled"
                    : data.pendingRun.status === "running"
                      ? "Update in progress"
                      : "Update scheduled"}
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">
                      {data.pendingRun.kind === "rollback" ? "Rolling back to" : "Target version"}
                    </span>
                    <span className="font-mono text-slate-700">
                      {data.pendingRun.fromVersion
                        ? `${withV(data.pendingRun.fromVersion)} → ${data.pendingRun.targetVersion}`
                        : data.pendingRun.targetVersion}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">
                      {data.pendingRun.status === "running" ? "Started" : "Scheduled for"}
                    </span>
                    <span className="text-slate-700">
                      {formatDate(data.pendingRun.startedAt ?? data.pendingRun.scheduledAt)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Triggered by</span>
                    <span className="text-slate-700">{data.pendingRun.triggeredBy}</span>
                  </div>
                </div>
                {data.pendingRun.status === "queued" && (
                  <button
                    onClick={() => cancelMutation.mutate(data.pendingRun!.id)}
                    disabled={!canWrite || cancelMutation.isPending}
                    className="mt-3 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                  >
                    {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
                  </button>
                )}
                {data.pendingRun.status === "running" && (
                  <>
                    <p className="mt-3 text-xs text-slate-500">
                      The api/web/worker containers restart during this step — brief connection
                      errors here are expected.
                    </p>
                    {/* The updater sidecar (infra/updater/run.sh) flushes partial output back
                     *  to this row every few seconds while it runs, so this fills in live as
                     *  the 5s poll above picks up each flush — not just once at the end. */}
                    <div className="mt-3">
                      <div className="mb-1 text-xs font-medium text-slate-500">Live output</div>
                      <pre
                        ref={(el) => {
                          if (el) el.scrollTop = el.scrollHeight;
                        }}
                        className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-[11px] text-slate-600"
                      >
                        {data.pendingRun.output || "Waiting for the updater to start…"}
                      </pre>
                    </div>
                  </>
                )}
              </Card>
            ) : (
              <Card className="max-w-lg">
                <div className="mb-3 text-sm font-medium text-slate-700">Apply update</div>
                {!data.updateAvailable ? (
                  <p className="text-sm text-slate-500">You're already on the latest version.</p>
                ) : (
                  <>
                    <div className="mb-3 flex gap-2">
                      {(["now", "once"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setWhenMode(mode)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                            whenMode === mode
                              ? "bg-slate-900 text-white"
                              : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          {mode === "now" ? "Run now" : "Schedule"}
                        </button>
                      ))}
                    </div>
                    {whenMode === "once" && (
                      <div className="mb-3">
                        <DateTimePicker value={scheduleAt} onChange={setScheduleAt} />
                      </div>
                    )}
                    <button
                      onClick={submitTrigger}
                      disabled={
                        !canWrite || triggerPending || (whenMode === "once" && !scheduleAt)
                      }
                      title={!canWrite ? "Your role doesn't include settings write access." : undefined}
                      className="rounded-md bg-[var(--pp-primary)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-90 disabled:opacity-50"
                    >
                      {triggerPending
                        ? "Submitting…"
                        : whenMode === "now"
                          ? `Update to v${data.latestVersion}`
                          : "Schedule update"}
                    </button>
                    {triggerError && (
                      <p className="mt-2 text-xs text-rose-600">{describeTriggerError(triggerError)}</p>
                    )}
                  </>
                )}
              </Card>
            )
          )}

          {!demoMode && data.history.length > 0 && (
            <Card className="max-w-lg">
              <div className="mb-3 text-sm font-medium text-slate-700">History</div>
              <div className="space-y-3">
                {data.history.map((run) => (
                  <div key={run.id} className="border-t border-slate-100 pt-3 first:border-0 first:pt-0">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-mono text-slate-700">
                        {run.fromVersion ? `${withV(run.fromVersion)} → ${run.targetVersion}` : run.targetVersion}
                      </span>
                      <span
                        className={
                          run.status === "succeeded"
                            ? "text-xs font-medium text-emerald-600"
                            : "text-xs font-medium text-rose-600"
                        }
                      >
                        {run.status === "succeeded"
                          ? run.kind === "rollback"
                            ? "Rolled back"
                            : "Succeeded"
                          : "Failed"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {formatDate(run.finishedAt)} · triggered by {run.triggeredBy}
                    </div>
                    {run.output && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
                          View output
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">
                          {run.output}
                        </pre>
                      </details>
                    )}
                    {canWrite &&
                      !demoMode &&
                      !data.pendingRun &&
                      run.status === "succeeded" &&
                      run.targetVersion !== `v${data.currentVersion}` && (
                        <button
                          type="button"
                          onClick={() => setPendingRollback(run)}
                          className="mt-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:underline"
                        >
                          Roll back to this version
                        </button>
                      )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {pendingRollback && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => !rollbackMutation.isPending && setPendingRollback(null)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-sm rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 className="text-base font-semibold text-slate-900">
              Roll back to {pendingRollback.targetVersion}?
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              This reverts application code only — any database changes made since{" "}
              {pendingRollback.targetVersion} are not undone. The updater sidecar applies this the
              same way it applies a forward update.
            </p>
            {rollbackMutation.isError && (
              <p className="mt-2 text-xs text-rose-600">
                {describeTriggerError(rollbackMutation.error)}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRollback(null)}
                disabled={rollbackMutation.isPending}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => rollbackMutation.mutate(pendingRollback.targetVersion)}
                disabled={rollbackMutation.isPending}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-50"
              >
                {rollbackMutation.isPending ? "Rolling back…" : "Roll back"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
