import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { csvRow } from "@patchpilot/shared";
import {
  api,
  type BulkArchiveResult,
  type BulkDeleteResult,
  type Device,
  type Job,
  type JobStatus,
  type Schedule,
  type Vulnerability,
} from "../lib/api";
import { useCan } from "../lib/auth";
import { useTenant } from "../lib/tenant";
import { Card, PageHeader } from "../components/ui";
import { downloadCsv } from "../lib/csv";

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: "bg-slate-100 text-slate-600",
  running: "bg-sky-100 text-sky-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
};

function StatusChip({ status }: { status: JobStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

const STATUS_ORDER: JobStatus[] = ["failed", "running", "queued", "succeeded"];

function BatchStatusSummary({ jobs }: { jobs: Job[] }) {
  const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0 };
  for (const j of jobs) counts[j.status]++;
  return (
    <div className="flex flex-wrap gap-1">
      {STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
        <span
          key={s}
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[s]}`}
        >
          {counts[s]} {s}
        </span>
      ))}
    </div>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  "live-response": "Live Response",
  "intune-remediation": "Intune Remediation",
  "win32-app": "Win32 app",
  "expedited-quality-update": "Expedited Quality Update",
};

/** dd/mm/yyyy plus local time — explicit rather than toLocaleString()'s
 *  locale-dependent (often ambiguous mm/dd/yyyy) default. */
function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}/${month}/${d.getFullYear()} ${time}`;
}

type SortKey = "queuedAt" | "finishedAt" | "status";

type GroupBy = "batch" | "schedule" | "cve" | "software" | "device" | "none";

export function Jobs() {
  const { activeTenantId } = useTenant();
  const canWrite = useCan("operations:write");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  // Status filter lives in the URL so the Dashboard's remediation throughput
  // chart can deep-link straight to filtered jobs.
  const statusFilter = (params.get("status") as JobStatus | "all") || "all";
  const setStatusFilter = (value: JobStatus | "all") =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "all") next.delete("status");
        else next.set("status", value);
        return next;
      },
      { replace: true },
    );
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("batch");
  const [sortKey, setSortKey] = useState<SortKey>("queuedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkError, setBulkError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const queryKey = ["jobs", activeTenantId, showArchived];
  const {
    data: jobs = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery<Job[]>({
    queryKey,
    queryFn: () =>
      api.get<Job[]>(
        `/api/jobs?tenantId=${activeTenantId}&includeArchived=${showArchived}`,
      ),
    enabled: !!activeTenantId,
    // Poll so simulated queued -> running -> succeeded transitions show live.
    refetchInterval: 1500,
  });

  // Legacy fallback only: jobs created before the software/deviceHostname
  // columns existed have those fields as null, so for those rows alone we
  // reconstruct a display value from the current tenant-scoped lists. Newer
  // jobs carry their own dispatch-time snapshot (see `resolveSoftware` /
  // `resolveHostname` below) which is immune to later renames, resyncs, or
  // shared-engine CVE duplicate rows corrupting the historical record.
  const { data: vulns = [] } = useQuery<Vulnerability[]>({
    queryKey: ["vulnerabilities", activeTenantId],
    queryFn: () => api.get<Vulnerability[]>(`/api/vulnerabilities?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });
  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["devices", activeTenantId],
    queryFn: () => api.get<Device[]>(`/api/devices?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });
  // Batch rows fired by a recurring schedule show the schedule's name rather
  // than a generic "Batch" label.
  const { data: schedules = [] } = useQuery<Schedule[]>({
    queryKey: ["schedules", activeTenantId],
    queryFn: () => api.get<Schedule[]>(`/api/schedules?tenantId=${activeTenantId}`),
    enabled: !!activeTenantId,
  });
  const scheduleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of schedules) map.set(s.id, s.name);
    return map;
  }, [schedules]);

  const softwareByCve = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vulns) map.set(v.cveId, v.displayName || v.software);
    return map;
  }, [vulns]);
  const hostnameByDeviceId = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devices) map.set(d.id, d.hostname);
    return map;
  }, [devices]);

  // Prefer the dispatch-time snapshot; only fall back to the live join for
  // legacy rows (software / deviceHostname null) predating that column.
  const resolveSoftware = (job: Job): string | undefined =>
    job.software ?? (job.cveId ? softwareByCve.get(job.cveId) : undefined);
  const resolveHostname = (job: Job): string | undefined =>
    job.deviceHostname ?? (job.deviceId ? hostnameByDeviceId.get(job.deviceId) : undefined);

  const visibleJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = jobs.filter((job) => {
      if (statusFilter !== "all" && job.status !== statusFilter) return false;
      if (channelFilter !== "all" && job.channel !== channelFilter) return false;
      if (!q) return true;
      const software = resolveSoftware(job) ?? "";
      const hostname = resolveHostname(job) ?? "";
      const haystack = [job.cveId, software, job.engineer, hostname, job.channel]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "status") return dir * a.status.localeCompare(b.status);
      const aVal = a[sortKey] ?? "";
      const bVal = b[sortKey] ?? "";
      return dir * aVal.localeCompare(bVal);
    });
  }, [jobs, search, statusFilter, channelFilter, sortKey, sortDir, softwareByCve, hostnameByDeviceId]);

  const channelOptions = useMemo(
    () => Array.from(new Set(jobs.map((j) => j.channel))),
    [jobs],
  );

  // Group jobs sharing a correlating key into one expandable row. Default
  // mode ("batch") clusters same-dispatch-event jobs (a schedule fire, a Fix
  // All, or a multi-device Run Now); other modes let the user re-cluster by
  // schedule/CVE/software/device across the whole visible list instead. A
  // key that's shared by only one job after the current search/filter
  // renders as a standalone row — grouping one job under itself would be
  // pointless. A `null` key (e.g. a manual job's scheduleId) never groups,
  // so manual jobs always stay standalone rather than piling into one
  // meaningless "no schedule" bucket.
  type JobRow =
    | { kind: "group"; groupKey: string; jobs: Job[] }
    | { kind: "single"; job: Job };

  function groupKeyOf(job: Job): string | null {
    switch (groupBy) {
      case "batch":
        return job.batchId;
      case "schedule":
        return job.scheduleId;
      case "cve":
        return job.cveId;
      case "software":
        return resolveSoftware(job) ?? null;
      case "device":
        return job.deviceId;
      case "none":
        return null;
    }
  }

  const rows = useMemo<JobRow[]>(() => {
    const byKey = new Map<string, Job[]>();
    for (const job of visibleJobs) {
      const key = groupKeyOf(job);
      if (!key) continue;
      const arr = byKey.get(key);
      if (arr) arr.push(job);
      else byKey.set(key, [job]);
    }
    const seenKey = new Set<string>();
    const result: JobRow[] = [];
    for (const job of visibleJobs) {
      const key = groupKeyOf(job);
      const group = key ? byKey.get(key) : undefined;
      if (group && group.length > 1) {
        if (seenKey.has(key!)) continue;
        seenKey.add(key!);
        result.push({ kind: "group", groupKey: key!, jobs: group });
      } else {
        result.push({ kind: "single", job });
      }
    }
    return result;
  }, [visibleJobs, groupBy]);

  function groupLabel(groupJobs: Job[]): string {
    const first = groupJobs[0]!;
    const count = groupJobs.length;
    switch (groupBy) {
      // Schedule name already has its own dedicated "Job Name" column —
      // don't duplicate it here.
      case "schedule":
        return "—";
      case "cve":
        return `${first.cveId ?? "—"} — ${count} jobs`;
      case "software":
        return `${resolveSoftware(first) ?? "—"} — ${count} jobs`;
      case "device":
        return `${resolveHostname(first) ?? "—"} — ${count} jobs`;
      case "batch":
      case "none":
      default:
        break;
    }
    // "batch" mode: fall back through the same signals a dispatch-event
    // batch tends to share, in order of how identifying they are. A
    // schedule-driven batch stops here — the "Job Name" column already
    // shows the name, so this cell stays blank rather than duplicating it.
    if (first.scheduleId) {
      return "—";
    }
    const cveIds = new Set(groupJobs.map((j) => j.cveId).filter(Boolean));
    if (cveIds.size === 1 && first.cveId) {
      return `${first.cveId} — ${count} devices`;
    }
    const hostnames = new Set(groupJobs.map((j) => j.deviceHostname).filter(Boolean));
    if (hostnames.size === 1 && first.deviceHostname) {
      return `${first.deviceHostname} — ${count} fixes`;
    }
    const softwareNames = new Set(groupJobs.map((j) => j.software).filter(Boolean));
    if (softwareNames.size === 1 && first.software) {
      return `${first.software} — ${count} devices`;
    }
    return `Batch — ${count} jobs`;
  }

  function uniformOrMultiple<T>(values: (T | null)[]): T | "Multiple" | null {
    const distinct = new Set(values.filter((v): v is T => v !== null));
    if (distinct.size === 0) return null;
    if (distinct.size === 1) return [...distinct][0]!;
    return "Multiple";
  }

  // Job Name only populates for scheduled/automated jobs — a manual "Fix
  // now" job has no name of its own, so its cell stays blank.
  function renderScheduleCell(scheduleId: string | "Multiple" | null) {
    if (scheduleId === "Multiple") return <span className="text-slate-600">Multiple</span>;
    if (!scheduleId) return <span className="text-slate-400">—</span>;
    return <span>{scheduleNameById.get(scheduleId) ?? "Recurring schedule"}</span>;
  }

  // Unlike uniformOrMultiple, treats null (manual) as its own distinct value
  // rather than filtering it out — a group mixing manual and scheduled jobs
  // must render "Multiple", not silently pick the one non-null schedule.
  function uniformOrMultipleSchedule(values: (string | null)[]): string | "Multiple" | null {
    const distinct = new Set(values);
    if (distinct.size === 1) return [...distinct][0]!;
    return "Multiple";
  }

  const archiveMutation = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.patch<Job>(`/api/jobs/${id}/archive`, { archived }),
    onSuccess: (_data, { id }) => {
      setNotice((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error, { id }) => {
      setNotice((prev) => ({ ...prev, [id]: err.message }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.del<void>(`/api/jobs/${id}`),
    onSuccess: (_data, id) => {
      setNotice((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error, id) => {
      setNotice((prev) => ({ ...prev, [id]: err.message }));
    },
  });

  const retryMutation = useMutation({
    mutationFn: (id: string) => api.post<{ job: Job }>(`/api/jobs/${id}/retry`, {}),
    onSuccess: (_data, id) => {
      setNotice((prev) => {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error, id) => {
      setNotice((prev) => ({ ...prev, [id]: err.message }));
    },
  });

  const bulkArchiveMutation = useMutation({
    mutationFn: ({ ids, archived }: { ids: string[]; archived: boolean }) =>
      api.post<BulkArchiveResult>("/api/jobs/bulk-archive", { ids, archived }),
    onSuccess: () => {
      setSelected(new Set());
      setBulkError(null);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => setBulkError(err.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => api.post<BulkDeleteResult>("/api/jobs/bulk-delete", { ids }),
    onSuccess: () => {
      setSelected(new Set());
      setBulkError(null);
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => setBulkError(err.message),
  });

  // Selection is scoped to ids that still exist so a completed mutation, tenant
  // switch, or the archived-jobs toggle can't leave phantom rows "selected".
  useEffect(() => {
    const jobIds = new Set(jobs.map((j) => j.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => jobIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [jobs]);

  const selectedJobs = useMemo(
    () => jobs.filter((j) => selected.has(j.id)),
    [jobs, selected],
  );
  const allSelectedArchived = selectedJobs.length > 0 && selectedJobs.every((j) => !!j.archivedAt);
  const allVisibleSelected =
    visibleJobs.length > 0 && visibleJobs.every((j) => selected.has(j.id));

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const j of visibleJobs) next.delete(j.id);
        return next;
      }
      const next = new Set(prev);
      for (const j of visibleJobs) next.add(j.id);
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleBatchSelect = (batchJobs: Job[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = batchJobs.every((j) => next.has(j.id));
      for (const j of batchJobs) {
        if (allSelected) next.delete(j.id);
        else next.add(j.id);
      }
      return next;
    });
  };

  function exportCsv() {
    const csv =
      csvRow([
        "cve",
        "software",
        "device",
        "channel",
        "status",
        "engineer",
        "queued_at",
        "started_at",
        "finished_at",
        "exit_code",
        "archived",
      ]) +
      visibleJobs
        .map((job) =>
          csvRow([
            job.cveId ?? "",
            resolveSoftware(job) ?? "",
            resolveHostname(job) ?? "",
            CHANNEL_LABELS[job.channel] ?? job.channel,
            job.status,
            job.engineer,
            job.queuedAt,
            job.startedAt ?? "",
            job.finishedAt ?? "",
            job.exitCode ?? "",
            !!job.archivedAt,
          ]),
        )
        .join("");
    downloadCsv("jobs.csv", csv);
  }

  // Shared by standalone rows and by the nested rows inside an expanded batch
  // — `nested` only tweaks styling (indent + a faint tint) so batch members
  // read as a sub-list rather than a second set of top-level rows.
  function renderJobRow(job: Job, nested = false) {
    const isOpen = expanded === job.id;
    const isArchived = !!job.archivedAt;
    const software = resolveSoftware(job);
    const hostname = resolveHostname(job);
    return (
      <Fragment key={job.id}>
        <tr
          onClick={() => setExpanded(isOpen ? null : job.id)}
          className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 ${isArchived ? "opacity-60" : ""} ${nested ? "bg-slate-50/40" : ""}`}
        >
          <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected.has(job.id)}
              onChange={() => toggleSelect(job.id)}
              className="rounded border-slate-300"
              aria-label={`Select job ${job.id}`}
            />
          </td>
          <td className="px-5 py-3">{renderScheduleCell(job.scheduleId)}</td>
          <td className={`px-5 py-3 font-medium text-slate-800 ${nested ? "pl-9" : ""}`}>
            {job.cveId ?? "—"}
            {job.coveredCveIds && job.coveredCveIds.length > 0 ? (
              <span
                className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal text-slate-500"
                title={`Same fix also closes: ${job.coveredCveIds.join(", ")}`}
              >
                +{job.coveredCveIds.length}
              </span>
            ) : null}
          </td>
          <td className="px-5 py-3 text-slate-600">{software ?? "—"}</td>
          <td className="px-5 py-3 text-slate-600">
            {job.deviceId ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/devices?device=${encodeURIComponent(job.deviceId!)}`);
                }}
                className="text-sky-700 underline-offset-2 hover:underline"
                title="View device details"
              >
                {hostname ?? "—"}
              </button>
            ) : (
              (hostname ?? "—")
            )}
          </td>
          <td className="px-5 py-3 text-slate-600">
            {CHANNEL_LABELS[job.channel] ?? job.channel}
          </td>
          <td className="px-5 py-3">
            <StatusChip status={job.status} />
          </td>
          <td className="px-5 py-3 text-slate-600">{job.engineer}</td>
          <td className="px-5 py-3 text-slate-500">
            {fmt(job.queuedAt)}
          </td>
          <td className="px-5 py-3 text-slate-500">
            {fmt(job.finishedAt)}
          </td>
          <td className="px-5 py-3">
            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
              {job.status === "failed" && (
                <button
                  type="button"
                  onClick={() => retryMutation.mutate(job.id)}
                  disabled={!canWrite || !job.script || retryMutation.isPending}
                  title={
                    !canWrite
                      ? "Your role doesn't include remediation write access."
                      : !job.script
                        ? "This job predates retry support and can't be resubmitted automatically."
                        : undefined
                  }
                  className="text-xs font-medium text-sky-600 hover:text-sky-800 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  archiveMutation.mutate({ id: job.id, archived: !isArchived })
                }
                disabled={!canWrite}
                title={!canWrite ? "Your role doesn't include remediation write access." : undefined}
                className="text-xs font-medium text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                {isArchived ? "Restore" : "Archive"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete job ${job.id}? This cannot be undone.`)) {
                    deleteMutation.mutate(job.id);
                  }
                }}
                disabled={!canWrite}
                title={!canWrite ? "Your role doesn't include remediation write access." : undefined}
                className="text-xs font-medium text-rose-500 hover:text-rose-700 disabled:cursor-not-allowed disabled:text-slate-300"
              >
                Delete
              </button>
            </div>
            {notice[job.id] && (
              <p className="mt-1 text-xs text-rose-600">{notice[job.id]}</p>
            )}
          </td>
        </tr>
        {isOpen && (
          <tr key={`${job.id}-detail`} className="bg-slate-50">
            <td colSpan={11} className="px-5 py-4">
              <div className="mb-2 text-xs text-slate-500">
                Job {job.id} · exit code{" "}
                {job.exitCode === null ? "—" : job.exitCode} · started{" "}
                {fmt(job.startedAt)}
              </div>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
                {job.output ?? "(no output yet)"}
              </pre>
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  function renderGroupRow(groupKey: string, groupJobs: Job[]) {
    const isOpen = expandedBatch === groupKey;
    const allGroupSelected = groupJobs.every((j) => selected.has(j.id));
    const someGroupSelected = groupJobs.some((j) => selected.has(j.id));
    const channel = uniformOrMultiple(groupJobs.map((j) => j.channel));
    const scheduleId = uniformOrMultipleSchedule(groupJobs.map((j) => j.scheduleId));
    const engineer = uniformOrMultiple(groupJobs.map((j) => j.engineer));
    const queuedAts = groupJobs.map((j) => j.queuedAt).filter(Boolean).sort();
    const earliestQueued = queuedAts[0] ?? null;
    // Only show a finished timestamp once every job in the group has one —
    // a group that's still running has no single "finished at" yet.
    const finishedAts = groupJobs
      .map((j) => j.finishedAt)
      .filter((v): v is string => !!v)
      .sort();
    const latestFinished = finishedAts.length === groupJobs.length ? finishedAts[finishedAts.length - 1]! : null;
    return (
      <Fragment key={`group-${groupKey}`}>
        <tr
          onClick={() => setExpandedBatch(isOpen ? null : groupKey)}
          className="cursor-pointer border-b border-slate-100 bg-slate-50 last:border-0 hover:bg-slate-100"
        >
          <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={allGroupSelected}
              ref={(el) => {
                if (el) el.indeterminate = !allGroupSelected && someGroupSelected;
              }}
              onChange={() => toggleBatchSelect(groupJobs)}
              className="rounded border-slate-300"
              aria-label={`Select group ${groupKey}`}
            />
          </td>
          <td className="px-5 py-3">{renderScheduleCell(scheduleId)}</td>
          <td className="px-5 py-3 font-medium text-slate-800" colSpan={3}>
            <span className="mr-2 inline-block w-3 text-slate-400">{isOpen ? "▾" : "▸"}</span>
            {groupLabel(groupJobs)}
          </td>
          <td className="px-5 py-3 text-slate-600">
            {channel === null
              ? "—"
              : channel === "Multiple"
                ? "Multiple"
                : (CHANNEL_LABELS[channel] ?? channel)}
          </td>
          <td className="px-5 py-3">
            <BatchStatusSummary jobs={groupJobs} />
          </td>
          <td className="px-5 py-3 text-slate-600">{engineer ?? "—"}</td>
          <td className="px-5 py-3 text-slate-500">{fmt(earliestQueued)}</td>
          <td className="px-5 py-3 text-slate-500">{fmt(latestFinished)}</td>
          <td className="px-5 py-3 text-slate-500">{groupJobs.length} jobs</td>
        </tr>
        {isOpen && groupJobs.map((j) => renderJobRow(j, true))}
      </Fragment>
    );
  }

  return (
    <div>
      <PageHeader
        title="Jobs"
        subtitle="Every remediation run for this tenant, newest first. In demo mode jobs progress through queued → running → succeeded on a timer — no Microsoft API is called. Expand a row to see the simulated output."
        actions={
          <button
            type="button"
            onClick={exportCsv}
            disabled={visibleJobs.length === 0}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            Export CSV
          </button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded border-slate-300"
          />
          Show archived jobs
        </label>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search CVE, software, device, engineer…"
          className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as JobStatus | "all")}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
        </select>

        <select
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="all">All channels</option>
          {channelOptions.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c] ?? c}
            </option>
          ))}
        </select>

        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupBy)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="batch">Group: Batch</option>
          <option value="schedule">Group: Scheduled job</option>
          <option value="cve">Group: Finding (CVE)</option>
          <option value="software">Group: Affected software</option>
          <option value="device">Group: Device</option>
          <option value="none">Group: None (flat list)</option>
        </select>

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="queuedAt">Sort: Queued</option>
          <option value="finishedAt">Sort: Finished</option>
          <option value="status">Sort: Status</option>
        </select>

        <button
          type="button"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          title="Toggle sort direction"
        >
          {sortDir === "asc" ? "↑ Asc" : "↓ Desc"}
        </button>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm">
          <span className="font-medium text-slate-700">
            {selected.size} job{selected.size === 1 ? "" : "s"} selected
          </span>
          <button
            type="button"
            onClick={() =>
              bulkArchiveMutation.mutate({
                ids: [...selected],
                archived: !allSelectedArchived,
              })
            }
            disabled={!canWrite || bulkArchiveMutation.isPending || bulkDeleteMutation.isPending}
            title={!canWrite ? "Your role doesn't include remediation write access." : undefined}
            className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            {allSelectedArchived ? "Restore selected" : "Archive selected"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Delete ${selected.size} job(s)? This cannot be undone.`)) {
                bulkDeleteMutation.mutate([...selected]);
              }
            }}
            disabled={!canWrite || bulkArchiveMutation.isPending || bulkDeleteMutation.isPending}
            title={!canWrite ? "Your role doesn't include remediation write access." : undefined}
            className="rounded-md border border-rose-300 px-3 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            Delete selected
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs font-medium text-slate-500 hover:text-slate-700"
          >
            Clear selection
          </button>
          {bulkError && <span className="text-xs text-rose-600">{bulkError}</span>}
          {!canWrite && (
            <span className="text-xs text-amber-600">
              Your role doesn't include remediation write access.
            </span>
          )}
        </div>
      )}

      {isLoading ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">Loading jobs…</p>
        </Card>
      ) : jobs.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No remediation jobs yet for this tenant. Run one from a finding
            on Vulnerabilities, Recommendations, Devices, or Inventories.
          </p>
        </Card>
      ) : visibleJobs.length === 0 ? (
        <Card className="border-dashed">
          <p className="text-sm text-slate-500">
            No jobs match the current search/filter.
          </p>
        </Card>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3 font-medium">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      className="rounded border-slate-300"
                      aria-label="Select all jobs"
                    />
                  </th>
                  <th className="px-5 py-3 font-medium">Job Name</th>
                  <th className="px-5 py-3 font-medium">Finding</th>
                  <th className="px-5 py-3 font-medium">Affected Software</th>
                  <th className="px-5 py-3 font-medium">Device</th>
                  <th className="px-5 py-3 font-medium">Channel</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Engineer</th>
                  <th className="px-5 py-3 font-medium">Queued</th>
                  <th className="px-5 py-3 font-medium">Finished</th>
                  <th className="px-5 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.kind === "group"
                    ? renderGroupRow(row.groupKey, row.jobs)
                    : renderJobRow(row.job),
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
