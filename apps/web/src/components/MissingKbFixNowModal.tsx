import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CHANNEL_SPECS, selectableChannels, type RemediationChannel } from "@patchpilot/shared";
import {
  api,
  ApiError,
  type MissingKbFixResult,
  type PreflightReport,
  type PreflightStatus,
} from "../lib/api";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import {
  QualityUpdateOptionsPanel,
  defaultQualityUpdateOptions,
  type QualityUpdateOptionsValue,
} from "./QualityUpdateOptionsPanel";
import { SlideOver } from "./ui";

/**
 * Single-device "Fix Now" dialog for a missing Windows Update (KB), opened
 * from the Vulnerabilities/Devices "Missing KBs" tab's device drill-down. Mirrors
 * SoftwareFixNowModal.tsx exactly, but posts to /api/missing-kbs/fix and
 * offers only the OS-capable channels (selectableChannels("os")). When/Trigger
 * shape mirrors MissingKbFixAllModal.tsx's "Run now / Schedule once" pattern.
 */

type WhenMode = "now" | "once";

const WHEN_MODES: { id: WhenMode; label: string }[] = [
  { id: "now", label: "Fix now" },
  { id: "once", label: "Schedule once" },
];

const STATUS_STYLES: Record<PreflightStatus, string> = {
  pass: "bg-emerald-100 text-emerald-700",
  warn: "bg-amber-100 text-amber-700",
  fail: "bg-rose-100 text-rose-700",
};

const STATUS_LABELS: Record<PreflightStatus, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

function StatusChip({ status }: { status: PreflightStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Extracts the failing preflight report from a 422's parsed body, if any. */
function blockedReport(err: unknown): PreflightReport | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const report = (err.data as { report?: PreflightReport } | undefined)?.report;
  return report ?? null;
}

export function MissingKbFixNowModal({
  open,
  onClose,
  tenantId,
  missingKbId,
  kbId,
  title,
  hostname,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  /** The specific `missing_kbs` row id for this device — what Fix Now targets. */
  missingKbId: string;
  kbId: string;
  title: string;
  hostname: string;
}) {
  const canWrite = useCan("operations:write");
  const channels = selectableChannels("os");
  const [channel, setChannel] = useState<RemediationChannel>(channels[0]!);
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [quOptions, setQuOptions] = useState<QualityUpdateOptionsValue>(() =>
    defaultQualityUpdateOptions({ kbId }),
  );

  const fix = useMutation<MissingKbFixResult, Error>({
    mutationFn: () =>
      api.post<MissingKbFixResult>("/api/missing-kbs/fix", {
        tenantId,
        id: missingKbId,
        channel,
        scheduleAt: whenMode === "once" && scheduleAt ? scheduleAt.toISOString() : undefined,
        ...(channel === "expedited-quality-update"
          ? {
              qualityUpdateDisplayName: quOptions.displayName.trim() || undefined,
              qualityUpdateCatalogItemId: quOptions.catalogItemId || undefined,
              qualityUpdateDaysUntilForcedReboot: quOptions.daysUntilForcedReboot,
            }
          : {}),
      }),
  });

  // Reset when the dialog is re-opened for a different device/KB.
  useEffect(() => {
    if (!open) return;
    setChannel(channels[0]!);
    setWhenMode("now");
    setScheduleAt(null);
    setShowScript(false);
    setQuOptions(defaultQualityUpdateOptions({ kbId }));
    fix.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, missingKbId]);

  const canConfirm =
    canWrite &&
    !fix.isPending &&
    (whenMode !== "once" || (!!scheduleAt && scheduleAt.getTime() > Date.now())) &&
    (channel !== "expedited-quality-update" || !!quOptions.catalogItemId);

  const report = fix.isSuccess ? fix.data.report : blockedReport(fix.error);
  const blocked = fix.isError && !!report;

  return (
    <SlideOver open={open} onClose={onClose} title="Fix now" subtitle={`KB${kbId} — ${hostname}`} elevated>
      <div className="space-y-4">
        {!fix.isSuccess && (
          <div>
            <p className="mb-3 text-xs text-slate-500">{title}</p>

            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              1. When
            </span>
            <div className="mb-4 grid grid-cols-2 gap-2">
              {WHEN_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setWhenMode(mode.id)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    whenMode === mode.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {whenMode === "once" && (
              <div className="mb-4">
                <DateTimePicker value={scheduleAt} onChange={setScheduleAt} />
              </div>
            )}

            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              2. Trigger method
            </label>
            <div className="space-y-2">
              {channels.map((c) => {
                const s = CHANNEL_SPECS[c];
                const active = channel === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    className={`flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium">{s.label}</div>
                      <div
                        className={`mt-0.5 text-[10px] leading-tight ${
                          active ? "text-slate-300" : "text-slate-400"
                        }`}
                      >
                        {s.useCase} · {s.latency}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {channel === "expedited-quality-update" && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Expedited quality update options
                </div>
                <QualityUpdateOptionsPanel
                  value={quOptions}
                  onChange={setQuOptions}
                  tenantId={tenantId}
                  missingKbId={missingKbId}
                  disabled={fix.isPending}
                />
              </div>
            )}
          </div>
        )}

        {!canWrite && !fix.isSuccess && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Your role doesn't include remediation write access.
          </div>
        )}

        {fix.isError && !blocked && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {fix.error.message}
          </div>
        )}

        {blocked && report && (
          <div>
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              Blocked — at least one check failed.
            </div>
            <ul className="mt-2 rounded-lg border border-slate-200">
              {report.checks.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2.5 last:border-0"
                >
                  <div>
                    <div className="text-xs font-medium text-slate-800">{c.label}</div>
                    <div className="mt-0.5 text-[11px] text-slate-500">{c.detail}</div>
                  </div>
                  <StatusChip status={c.status} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {fix.isSuccess ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              <p className="text-sm font-medium">
                {whenMode === "once" && scheduleAt
                  ? `Scheduled for ${scheduleAt.toLocaleString()}.`
                  : "Queued."}
              </p>
              <Link
                to="/jobs"
                onClick={onClose}
                className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                Track on Jobs page →
              </Link>
            </div>
            <div>
              <button
                type="button"
                onClick={() => setShowScript((v) => !v)}
                className="text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                {showScript ? "Hide" : "Show"} deployable script (remediation payload)
              </button>
              {showScript && (
                <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                  {fix.data.script}
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={() => fix.mutate()}
              disabled={!canConfirm}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {fix.isPending
                ? whenMode === "once"
                  ? "Scheduling…"
                  : "Dispatching…"
                : whenMode === "once"
                  ? "Schedule"
                  : "Fix now"}
            </button>
          </div>
        )}
      </div>
    </SlideOver>
  );
}
