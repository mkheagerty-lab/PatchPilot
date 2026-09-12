import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  ApiError,
  type HostPatchingSettings,
  type ServerHealthHostRebootRequest,
  type ServerHealthHostRebootRequests,
  type ServerHealthHostStatus,
  type ServerHealthResources,
} from "../../lib/api";
import { useCan } from "../../lib/auth";
import { Card, KpiCard } from "../../components/ui";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TrendAreaChart } from "../../components/charts/TrendAreaChart";

/** Keeps ~2.5 minutes of history at the 2.5s poll interval below — enough to
 *  see a spike coming and going without the chart getting unreadably dense. */
const MAX_SAMPLES = 60;
const POLL_INTERVAL_MS = 2_500;
// Same cadence as ContainersPanel's own container-stats / control-requests
// polls — this tab isn't more time-sensitive than that one.
const HOST_STATUS_POLL_INTERVAL_MS = 15_000;
const HOST_REBOOT_POLL_INTERVAL_MS = 3_000;
const HOST_REBOOT_HISTORY_ROWS = 5;

interface Sample {
  time: string;
  cpuPercent: number | null;
  memoryPercent: number;
  diskPercent: number | null;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}

function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent.toFixed(0)}%`;
}

function describeHostPatchingError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    if (code === "demo_unsupported") {
      return "Changing host patching config needs the updater sidecar — not available in demo mode.";
    }
    if (code === "live_restore_required") {
      return "Turn on Docker live-restore first — otherwise a Docker Engine update would restart every container at once.";
    }
    return err.message;
  }
  return "Could not save host patching settings.";
}

function describeHostRebootError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.data as { error?: string } | undefined)?.error;
    if (code === "demo_unsupported") {
      return "Rebooting the server needs the updater sidecar — not available in demo mode.";
    }
    if (code === "host_reboot_already_pending") {
      return "A server reboot is already queued or in progress. Wait for it to finish first.";
    }
    return err.message;
  }
  return "Could not queue the server reboot.";
}

function HostRebootStatusPill({ status }: { status: ServerHealthHostRebootRequest["status"] }) {
  const styles: Record<ServerHealthHostRebootRequest["status"], string> = {
    queued: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
    issuing: "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400",
    issued: "bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400",
    confirmed: "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    failed: "bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400",
  };
  const labels: Record<ServerHealthHostRebootRequest["status"], string> = {
    queued: "Queued",
    issuing: "Issuing",
    issued: "Rebooting…",
    confirmed: "Confirmed",
    failed: "Failed",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

/**
 * Task-Manager-style live CPU/Memory/Disk graphs, built from a client-side
 * rolling sample buffer — there's no WebSocket/SSE infra in this app, so this
 * is TanStack Query's `refetchInterval` the same way Jobs.tsx polls, not a
 * push stream. `TrendAreaChart` is already generic enough for this; no new
 * chart component was needed.
 */
const PATCHING_DEFAULTS: Omit<HostPatchingSettings, "demoMode"> = {
  autoRebootEnabled: false,
  autoRebootTimeUtc: "03:30",
  dockerAutoUpdateEnabled: false,
  dockerLiveRestoreEnabled: false,
};

export function ResourcesPanel() {
  const qc = useQueryClient();
  const canWrite = useCan("settings:write");
  const [samples, setSamples] = useState<Sample[]>([]);
  // Guards against a query retry/refetch race appending the same sampledAt
  // twice — the buffer is keyed by wall-clock label, not a query cache key.
  const lastSampledAt = useRef<string | null>(null);
  const [patchingForm, setPatchingForm] = useState(PATCHING_DEFAULTS);
  const [patchingSaved, setPatchingSaved] = useState(false);
  const [confirmReboot, setConfirmReboot] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["server-health", "resources"],
    queryFn: () => api.get<ServerHealthResources>("/api/server-health/resources"),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const { data: hostStatus } = useQuery({
    queryKey: ["server-health", "host-status"],
    queryFn: () => api.get<ServerHealthHostStatus>("/api/server-health/host-status"),
    refetchInterval: HOST_STATUS_POLL_INTERVAL_MS,
  });

  const { data: patchingData, isLoading: patchingLoading } = useQuery({
    queryKey: ["settings", "host-patching"],
    queryFn: () => api.get<HostPatchingSettings>("/api/settings/host-patching"),
  });

  const { data: rebootData } = useQuery({
    queryKey: ["server-health", "host-reboot-requests"],
    queryFn: () => api.get<ServerHealthHostRebootRequests>("/api/server-health/host-reboot-requests"),
    refetchInterval: HOST_REBOOT_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    if (patchingData) {
      setPatchingForm({
        autoRebootEnabled: patchingData.autoRebootEnabled,
        autoRebootTimeUtc: patchingData.autoRebootTimeUtc,
        dockerAutoUpdateEnabled: patchingData.dockerAutoUpdateEnabled,
        dockerLiveRestoreEnabled: patchingData.dockerLiveRestoreEnabled,
      });
    }
  }, [patchingData]);

  const patchingMutation = useMutation({
    mutationFn: (next: typeof PATCHING_DEFAULTS) =>
      api.post<HostPatchingSettings>("/api/settings/host-patching", next),
    onSuccess: () => {
      setPatchingSaved(true);
      void qc.invalidateQueries({ queryKey: ["settings", "host-patching"] });
      setTimeout(() => setPatchingSaved(false), 2000);
    },
  });

  const rebootMutation = useMutation({
    mutationFn: () => api.post("/api/server-health/reboot-host", {}),
    onSuccess: () => {
      setConfirmReboot(false);
      void qc.invalidateQueries({ queryKey: ["server-health", "host-reboot-requests"] });
    },
  });

  useEffect(() => {
    if (!data || data.sampledAt === lastSampledAt.current) return;
    lastSampledAt.current = data.sampledAt;
    setSamples((prev) => {
      const next: Sample = {
        time: new Date(data.sampledAt).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
        cpuPercent: data.cpu.percent,
        memoryPercent: data.memory.percent,
        diskPercent: data.disk?.percent ?? null,
      };
      const combined = [...prev, next];
      return combined.length > MAX_SAMPLES ? combined.slice(combined.length - MAX_SAMPLES) : combined;
    });
  }, [data]);

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
        <p className="text-sm text-rose-600 dark:text-rose-400">Could not load resource usage.</p>
      </Card>
    );
  }

  return (
    <div>
      {data.demoMode && (
        <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          Demo mode: these are placeholder readings, not a live host sample.
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="CPU"
          value={formatPercent(data.cpu.percent)}
          hint={`${data.cpu.cores} core${data.cpu.cores === 1 ? "" : "s"}`}
          tone={data.cpu.percent !== null && data.cpu.percent > 90 ? "critical" : "default"}
        />
        <KpiCard
          label="Memory"
          value={formatPercent(data.memory.percent)}
          hint={`${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)}`}
          tone={data.memory.percent > 90 ? "critical" : "default"}
        />
        <KpiCard
          label="Disk"
          value={data.disk ? formatPercent(data.disk.percent) : "—"}
          hint={data.disk ? `${formatBytes(data.disk.usedBytes)} / ${formatBytes(data.disk.totalBytes)}` : "Unavailable"}
          tone={data.disk && data.disk.percent > 90 ? "critical" : "default"}
        />
        <KpiCard
          label="Pending Reboot"
          value={!hostStatus ? "—" : hostStatus.rebootRequired ? "Yes" : "No"}
          hint={
            !hostStatus
              ? "No sample yet"
              : hostStatus.stale
                ? "Status is stale — updater hasn't reported recently"
                : hostStatus.rebootRequired
                  ? (hostStatus.rebootRequiredPackages ?? "Kernel or library update pending")
                  : hostStatus.lastUnattendedUpgradeAt
                    ? `Last OS update ${new Date(hostStatus.lastUnattendedUpgradeAt).toLocaleString()}`
                    : "No OS update recorded yet"
          }
          tone={hostStatus?.rebootRequired ? "critical" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">CPU %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "cpuPercent", label: "CPU %", color: "#6366f1" }]}
            />
          </div>
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Memory %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "memoryPercent", label: "Memory %", color: "#0ea5e9" }]}
            />
          </div>
        </Card>
        <Card>
          <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">Disk %</div>
          <div className="h-48">
            <TrendAreaChart
              data={samples as unknown as Record<string, unknown>[]}
              xKey="time"
              series={[{ key: "diskPercent", label: "Disk %", color: "#f59e0b" }]}
            />
          </div>
        </Card>
      </div>

      <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
        Reflects the host machine — see infra/Dockerfile.api's doc comment on how procfs is shared
        with the container.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">Host Patching</div>
          <p className="mb-4 text-xs text-slate-400 dark:text-slate-500">
            Both toggles are off by default — nothing changes here until you opt in. Pushed to the host
            by the updater sidecar within ~15s of saving.
          </p>

          {!canWrite && (
            <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Your role doesn't include settings write access.
            </div>
          )}
          {patchingData?.demoMode && (
            <div className="mb-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Demo mode: no updater sidecar is running — these settings can't be saved.
            </div>
          )}

          {patchingLoading ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={patchingForm.autoRebootEnabled}
                    onChange={(e) => setPatchingForm((f) => ({ ...f, autoRebootEnabled: e.target.checked }))}
                    disabled={!canWrite}
                    className="rounded border-slate-300 dark:border-slate-700"
                  />
                  Automatically reboot after updates
                </label>
                {patchingForm.autoRebootEnabled && (
                  <div className="mt-2 ml-6 flex items-center gap-2">
                    <label className="text-xs text-slate-500 dark:text-slate-400" htmlFor="host-reboot-time">
                      Reboot time (server time, UTC)
                    </label>
                    <input
                      id="host-reboot-time"
                      type="time"
                      value={patchingForm.autoRebootTimeUtc}
                      onChange={(e) => setPatchingForm((f) => ({ ...f, autoRebootTimeUtc: e.target.value }))}
                      disabled={!canWrite}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-sm text-slate-800 dark:text-slate-100"
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    checked={patchingForm.dockerLiveRestoreEnabled}
                    onChange={(e) => {
                      const dockerLiveRestoreEnabled = e.target.checked;
                      setPatchingForm((f) => ({
                        ...f,
                        dockerLiveRestoreEnabled,
                        dockerAutoUpdateEnabled: dockerLiveRestoreEnabled ? f.dockerAutoUpdateEnabled : false,
                      }));
                    }}
                    disabled={!canWrite}
                    className="rounded border-slate-300 dark:border-slate-700"
                  />
                  Docker live-restore
                </label>
                <p className="mt-1 ml-6 text-xs text-slate-400 dark:text-slate-500">
                  Keeps containers running across a `dockerd` restart. Turning this on for the first time
                  still causes one brief all-container restart.
                </p>
              </div>

              <div>
                <label
                  className={`flex items-center gap-2 text-sm font-medium ${
                    patchingForm.dockerLiveRestoreEnabled
                      ? "text-slate-700 dark:text-slate-200"
                      : "text-slate-400 dark:text-slate-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={patchingForm.dockerAutoUpdateEnabled}
                    onChange={(e) => setPatchingForm((f) => ({ ...f, dockerAutoUpdateEnabled: e.target.checked }))}
                    disabled={!canWrite || !patchingForm.dockerLiveRestoreEnabled}
                    className="rounded border-slate-300 dark:border-slate-700"
                  />
                  Include Docker Engine in automatic updates
                </label>
                {!patchingForm.dockerLiveRestoreEnabled && (
                  <p className="mt-1 ml-6 text-xs text-slate-400 dark:text-slate-500">
                    Requires Docker live-restore above — otherwise a Docker Engine update would restart every
                    container at once.
                  </p>
                )}
              </div>

              {hostStatus?.dockerLiveRestoreActive !== null && hostStatus?.dockerLiveRestoreActive !== undefined && (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Actual daemon state: live-restore is currently{" "}
                  <span className="font-medium">{hostStatus.dockerLiveRestoreActive ? "on" : "off"}</span>.
                </p>
              )}

              {patchingMutation.isError && (
                <p className="rounded-md bg-red-50 dark:bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  {describeHostPatchingError(patchingMutation.error)}
                </p>
              )}

              <button
                type="button"
                onClick={() => patchingMutation.mutate(patchingForm)}
                disabled={!canWrite || patchingMutation.isPending}
                className="rounded-md bg-[var(--pp-primary)] px-4 py-2 text-sm font-medium text-white transition hover:brightness-90 disabled:opacity-50"
              >
                {patchingMutation.isPending ? "Saving…" : patchingSaved ? "Saved ✓" : "Save"}
              </button>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">Restart Server</div>
          <p className="mb-4 text-xs text-slate-400 dark:text-slate-500">
            Reboots the whole virtual machine — the OS and kernel, not just the containers. Different from
            "Restart entire stack" on the Containers tab, which only restarts containers.
          </p>

          {rebootData?.pendingRequest && (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-3">
              <div className="text-sm text-slate-700 dark:text-slate-300">Server reboot in progress</div>
              <HostRebootStatusPill status={rebootData.pendingRequest.status} />
            </div>
          )}

          {canWrite && (
            <button
              type="button"
              onClick={() => setConfirmReboot(true)}
              disabled={!!rebootData?.pendingRequest}
              className="rounded-md border border-rose-200 dark:border-rose-900/50 bg-white dark:bg-slate-900 px-3.5 py-2 text-sm font-medium text-rose-600 dark:text-rose-400 transition-colors hover:bg-rose-50 dark:hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Restart Server (OS reboot)
            </button>
          )}

          {rebootData && rebootData.history.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Recent reboots
              </h3>
              <ul>
                {rebootData.history.slice(0, HOST_REBOOT_HISTORY_ROWS).map((req) => (
                  <li
                    key={req.id}
                    className="flex items-start justify-between gap-4 border-b border-slate-100 dark:border-slate-800 py-2 last:border-0"
                  >
                    <div className="min-w-0 text-xs text-slate-500 dark:text-slate-400">
                      {req.requestedBy} · {new Date(req.createdAt).toLocaleString()}
                    </div>
                    <HostRebootStatusPill status={req.status} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmReboot}
        tone="destructive"
        title="Reboot the entire server?"
        description={
          <>
            This restarts the whole virtual machine — not just the containers. Everything, including this
            dashboard, will be briefly unreachable (about a minute) while the OS restarts. This is different
            from "Restart entire stack", which only restarts containers and never touches the OS or kernel.
          </>
        }
        confirmLabel="Reboot server"
        pendingLabel="Queuing…"
        pending={rebootMutation.isPending}
        error={rebootMutation.isError ? describeHostRebootError(rebootMutation.error) : null}
        onConfirm={() => rebootMutation.mutate()}
        onCancel={() => setConfirmReboot(false)}
      />
    </div>
  );
}
