import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csvRow } from "@patchpilot/shared";
import { api, type LocalDeviceGroup, type Schedule } from "../lib/api";
import { useCan } from "../lib/auth";
import { useTenant } from "../lib/tenant";
import { Card, PageHeader, ResponsiveTable, type ResponsiveTableColumn } from "../components/ui";
import { downloadCsv } from "../lib/csv";
import { NewScheduleModal } from "../components/NewScheduleModal";
import { describeCron } from "../components/RecurrencePicker";
import { CHANNEL_LABELS, summarizeTarget } from "../components/ScheduleTargetFields";

/** Shape returned by POST /api/schedules/:id/run. */
interface RunNowResult {
  queued: boolean;
  demo?: boolean;
  message?: string;
}

export function Schedules() {
  const { activeTenantId } = useTenant();
  const canWrite = useCan("operations:write");
  const qc = useQueryClient();
  const key = ["schedules", activeTenantId];

  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: key,
    queryFn: () => api.get<Schedule[]>(`/api/schedules?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  const { data: groups = [] } = useQuery<LocalDeviceGroup[]>({
    queryKey: ["device-groups", activeTenantId],
    queryFn: () => api.get<LocalDeviceGroup[]>(`/api/local-device-groups?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["schedules"] });

  const toggle = useMutation<Schedule, Error, Schedule>({
    mutationFn: (s) =>
      api.put<Schedule>(`/api/schedules/${s.id}`, { enabled: !s.enabled }),
    onSuccess: invalidate,
  });

  const remove = useMutation<void, Error, string>({
    mutationFn: (id) => api.del<void>(`/api/schedules/${id}`),
    onSuccess: invalidate,
  });

  // Transient per-schedule feedback for "Run now" (queued vs. DEMO_MODE notice).
  const [runNotice, setRunNotice] = useState<Record<string, string>>({});

  const runNow = useMutation<RunNowResult, Error, string>({
    mutationFn: (id) => api.post<RunNowResult>(`/api/schedules/${id}/run`, {}),
    onSuccess: (res, id) => {
      setRunNotice((prev) => ({
        ...prev,
        [id]: res.queued
          ? "Fired — worker is fanning out remediation jobs."
          : (res.message ?? "Nothing was dispatched."),
      }));
    },
    onError: (err, id) => {
      setRunNotice((prev) => ({ ...prev, [id]: err.message }));
    },
  });

  function exportCsv() {
    const csv =
      csvRow(["name", "cron", "channel", "engineer", "enabled"]) +
      schedules
        .map((s) =>
          csvRow([s.name, s.cron, CHANNEL_LABELS[s.channel] ?? s.channel, s.engineer ?? "", s.enabled]),
        )
        .join("");
    downloadCsv("schedules.csv", csv);
  }

  const scheduleColumns: ResponsiveTableColumn<Schedule>[] = [
    {
      key: "name",
      header: "Name / Status",
      primary: true,
      cell: (s) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800 dark:text-slate-100">{s.name}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                s.enabled
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              }`}
            >
              {s.enabled ? "Enabled" : "Paused"}
            </span>
          </div>
          {runNotice[s.id] && (
            <div className="mt-1 text-xs text-slate-400">{runNotice[s.id]}</div>
          )}
        </div>
      ),
    },
    {
      key: "frequency",
      header: "Frequency & Channel",
      cell: (s) => (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          <span title={s.cron}>{describeCron(s.cron)}</span>
          <div className="mt-0.5">
            {CHANNEL_LABELS[s.channel] ?? s.channel}
            {s.engineer ? ` · runs as ${s.engineer}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "target",
      header: "Target",
      cell: (s) => (
        <span
          title={summarizeTarget(s.target, groups)}
          className="line-clamp-2 max-w-xs text-xs text-slate-400"
        >
          {summarizeTarget(s.target, groups)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      fullWidthOnMobile: true,
      cell: (s) => (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => runNow.mutate(s.id)}
            disabled={!canWrite || !s.enabled || (runNow.isPending && runNow.variables === s.id)}
            title={
              !canWrite
                ? "Your role doesn't include remediation write access."
                : s.enabled
                  ? "Fire this schedule now instead of waiting for its next cron tick"
                  : "Enable the schedule to run it on demand"
            }
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {runNow.isPending && runNow.variables === s.id ? "Running…" : "Run now"}
          </button>
          <button
            onClick={() => setEditingSchedule(s)}
            disabled={!canWrite}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Edit
          </button>
          <button
            onClick={() => toggle.mutate(s)}
            disabled={!canWrite || toggle.isPending}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {s.enabled ? "Pause" : "Enable"}
          </button>
          <button
            onClick={() => remove.mutate(s.id)}
            disabled={!canWrite || remove.isPending}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition-colors hover:bg-rose-50 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-950/30"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="Recurring remediation runs for this tenant. When a schedule fires, the worker re-runs the same pre-flight gate on each match before enqueuing; creating or pausing one here is configuration only and is audited."
        actions={
          <>
            <button
              type="button"
              onClick={exportCsv}
              disabled={schedules.length === 0}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700"
            >
              New schedule
            </button>
          </>
        }
      />

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading schedules…</p>
        </Card>
      ) : schedules.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No schedules yet for this tenant. Click "New schedule" to create one.
          </p>
        </Card>
      ) : (
        <ResponsiveTable columns={scheduleColumns} rows={schedules} rowKey={(s) => s.id} />
      )}

      <NewScheduleModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        tenantId={activeTenantId}
        groups={groups}
      />

      <NewScheduleModal
        open={!!editingSchedule}
        onClose={() => setEditingSchedule(null)}
        tenantId={activeTenantId}
        groups={groups}
        schedule={editingSchedule}
      />
    </div>
  );
}
