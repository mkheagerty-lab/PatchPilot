import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CHANNEL_SPECS, selectableChannels, type RemediationChannel } from "@patchpilot/shared";
import {
  api,
  type MissingKbFixAllResult,
  type MissingKbGroupDevice,
  type QualityUpdateCampaign,
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
 * Bulk "Fix all" dialog for one grouped missing KB — dispatches Fix Now
 * across every device (or a checklist subset) currently missing it. Mirrors
 * SoftwareInventoryFixAllModal.tsx's When/Trigger/checklist shape, simplified:
 * missing-KB targets are already fully known rows from the KB group, so
 * there's no winget/chocolatey package picker or scope filter — just OS-
 * capable channels (selectableChannels("os")) and a device checklist.
 */

type WhenMode = "now" | "once";

const WHEN_MODES: { id: WhenMode; label: string }[] = [
  { id: "now", label: "Fix now" },
  { id: "once", label: "Schedule once" },
];

export function MissingKbFixAllModal({
  open,
  onClose,
  tenantId,
  kbId,
  title,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  kbId: string;
  title: string;
  devices: MissingKbGroupDevice[];
}) {
  const canWrite = useCan("operations:write");
  const channels = selectableChannels("os");
  const [channel, setChannel] = useState<RemediationChannel>(channels[0]!);
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quOptions, setQuOptions] = useState<QualityUpdateOptionsValue>(() =>
    defaultQualityUpdateOptions({ kbId }),
  );
  const firstMissingKbId = devices[0]?.missingKbId ?? "";
  const isQualityUpdate = channel === "expedited-quality-update";
  const isGroupMode = isQualityUpdate && quOptions.groupId !== "";

  const fixAll = useMutation<MissingKbFixAllResult, Error>({
    mutationFn: () =>
      api.post<MissingKbFixAllResult>("/api/missing-kbs/fix-all", {
        tenantId,
        kbId,
        channel,
        deviceIds: [...selected],
        scheduleAt: whenMode === "once" && scheduleAt ? scheduleAt.toISOString() : undefined,
        ...(isQualityUpdate
          ? {
              qualityUpdateDisplayName: quOptions.displayName.trim() || undefined,
              qualityUpdateCatalogItemId: quOptions.catalogItemId || undefined,
              qualityUpdateDaysUntilForcedReboot: quOptions.daysUntilForcedReboot,
            }
          : {}),
      }),
  });

  const campaign = useMutation<QualityUpdateCampaign, Error>({
    mutationFn: () =>
      api.post<QualityUpdateCampaign>("/api/missing-kbs/quality-update-campaigns", {
        tenantId,
        displayName: quOptions.displayName.trim(),
        kbId,
        catalogItemId: quOptions.catalogItemId,
        releaseLabel: quOptions.releaseLabel,
        daysUntilForcedReboot: quOptions.daysUntilForcedReboot,
        groupId: quOptions.groupId,
        groupName: quOptions.groupName,
        excludeGroupId: quOptions.excludeGroupId || undefined,
        excludeGroupName: quOptions.excludeGroupName || undefined,
      }),
  });

  // Reset every time the modal reopens for a (possibly different) KB — every
  // device starts checked, matching Fix All's prior default-all behavior.
  useEffect(() => {
    if (!open) return;
    setChannel(channels[0]!);
    setWhenMode("now");
    setScheduleAt(null);
    setSelected(new Set(devices.map((d) => d.deviceId)));
    setQuOptions(defaultQualityUpdateOptions({ kbId }));
    fixAll.reset();
    campaign.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kbId]);

  const toggle = (deviceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  const selectedCount = selected.size;
  const spec = CHANNEL_SPECS[channel];
  const isPending = isGroupMode ? campaign.isPending : fixAll.isPending;
  const isSuccess = isGroupMode ? campaign.isSuccess : fixAll.isSuccess;
  const isError = isGroupMode ? campaign.isError : fixAll.isError;
  const canConfirm =
    canWrite &&
    !isPending &&
    (isGroupMode
      ? !!quOptions.catalogItemId
      : selectedCount > 0 &&
        (whenMode !== "once" || (!!scheduleAt && scheduleAt.getTime() > Date.now())) &&
        (!isQualityUpdate || !!quOptions.catalogItemId));

  return (
    <SlideOver open={open} onClose={onClose} title="Fix all" subtitle={`KB${kbId} — ${title}`} elevated>
      <div className="space-y-5">
        {!isSuccess && (
          <>
            {!isGroupMode && (
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  1. When
                </span>
                <div className="grid grid-cols-2 gap-2">
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
                  <div className="mt-2">
                    <DateTimePicker value={scheduleAt} onChange={setScheduleAt} />
                  </div>
                )}
              </div>
            )}

            <div>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {isGroupMode ? "1. Trigger method" : "2. Trigger method"}
              </span>
              <div className="space-y-1.5">
                {channels.map((c) => {
                  const s = CHANNEL_SPECS[c];
                  const active = channel === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setChannel(c)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{s.label}</span>
                        <span className={active ? "text-slate-300" : "text-slate-400"}>
                          {s.latency}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {isQualityUpdate && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Expedited quality update options
                  </div>
                  <QualityUpdateOptionsPanel
                    value={quOptions}
                    onChange={setQuOptions}
                    tenantId={tenantId}
                    missingKbId={firstMissingKbId}
                    disabled={isPending}
                    showAssignments
                  />
                </div>
              )}
            </div>

            {!isGroupMode && (
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  3. Devices ({selectedCount} of {devices.length} selected)
                </span>
                {devices.length === 0 ? (
                  <p className="text-sm text-slate-500">Nothing to fix.</p>
                ) : (
                  <ul className="max-h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-slate-200">
                    {devices.map((d) => {
                      const checked = selected.has(d.deviceId);
                      return (
                        <li
                          key={d.deviceId}
                          className="flex items-center gap-2.5 border-b border-slate-100 px-3 py-2.5 last:border-0"
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded border-slate-300"
                            checked={checked}
                            onChange={() => toggle(d.deviceId)}
                          />
                          <span className="truncate text-sm font-medium text-slate-800">
                            {d.hostname}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {isGroupMode && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Group mode targets every device in "{quOptions.groupName}" directly through
                Intune — the device checklist above and the When/schedule options don't apply here.
              </div>
            )}
          </>
        )}

        {!canWrite && !isSuccess && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Your role doesn't include remediation write access.
          </div>
        )}

        {isError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {(isGroupMode ? campaign.error : fixAll.error)?.message}
          </div>
        )}

        {campaign.isSuccess && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
            <p className="text-sm font-medium">
              Campaign "{campaign.data.displayName}" created and assigned to "{quOptions.groupName}".
              Intune now owns delivery to the group.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
            >
              Done
            </button>
          </div>
        )}

        {fixAll.isSuccess && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              <p className="text-sm font-medium">
                {fixAll.data.jobsCreated === 0
                  ? "No jobs created — every device was skipped."
                  : whenMode === "once" && scheduleAt
                    ? `${fixAll.data.jobsCreated} remediation job${fixAll.data.jobsCreated === 1 ? "" : "s"} scheduled for ${scheduleAt.toLocaleString()}.`
                    : `${fixAll.data.jobsCreated} remediation job${fixAll.data.jobsCreated === 1 ? "" : "s"} started.`}
              </p>
              {fixAll.data.jobsCreated > 0 && (
                <Link
                  to="/jobs"
                  onClick={onClose}
                  className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700"
                >
                  Track on Jobs page →
                </Link>
              )}
            </div>
            {fixAll.data.skipped.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">Skipped</div>
                <ul className="rounded-lg border border-slate-200">
                  {fixAll.data.skipped.map((s, i) => (
                    <li
                      key={`${s.label}-${i}`}
                      className="border-b border-slate-100 px-3 py-2 text-xs last:border-0"
                    >
                      <span className="font-medium text-slate-700">{s.label}</span>
                      <span className="text-slate-500">: {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!isSuccess && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={() => (isGroupMode ? campaign.mutate() : fixAll.mutate())}
              disabled={!canConfirm}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {isGroupMode
                ? campaign.isPending
                  ? "Creating campaign…"
                  : "Create campaign"
                : fixAll.isPending
                  ? whenMode === "once"
                    ? "Scheduling…"
                    : "Dispatching…"
                  : whenMode === "once"
                    ? `Schedule ${selectedCount || ""} via ${spec.label}`.replace("  ", " ")
                    : `Fix ${selectedCount || ""} via ${spec.label}`.replace("  ", " ")}
            </button>
          </div>
        )}
      </div>
    </SlideOver>
  );
}
