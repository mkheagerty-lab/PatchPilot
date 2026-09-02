import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type DeviceGroup,
  type ExceptionJustification,
  type ExceptionScope,
  type RecommendationException,
} from "../lib/api";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import { SlideOver } from "./ui";

/**
 * Records an engineer's intent to except a recommendation or CVE from
 * PatchPilot's own views (hidden by default, revealable via a status
 * filter — see recommendations.ts's isExcepted/loadActiveExceptions).
 * Defender has no public write API for exceptions ("Exceptions are
 * currently only supported in the Microsoft Defender portal, and not via
 * public API." — MS Learn), so this is a local-only record: it never calls
 * Defender, and the reminder below is non-dismissable because the engineer
 * still has to create the matching exception in the portal by hand.
 */

const JUSTIFICATIONS: { value: ExceptionJustification; label: string; cveOnly?: boolean }[] = [
  { value: "third-party-control", label: "Third party control" },
  { value: "alternate-mitigation", label: "Alternate mitigation" },
  { value: "risk-accepted", label: "Risk accepted" },
  { value: "planned-remediation", label: "Planned remediation (grace period)" },
  { value: "cve-no-patch", label: "CVE has no patch available", cveOnly: true },
  { value: "false-positive", label: "False positive", cveOnly: true },
];

type Duration = 30 | 60 | 90 | "custom";
const DURATIONS: { value: Duration; label: string }[] = [
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: "custom", label: "Custom" },
];

const MAX_CUSTOM_MS = 366 * 24 * 60 * 60 * 1000;

const REMINDER = (
  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
    <span className="font-semibold">Defender can't be updated via API.</span>{" "}
    Microsoft only supports exceptions through the Defender portal — this
    record is local to PatchPilot only. You must still create the matching
    exception yourself in the Defender portal (Vulnerability management →
    Recommendations → Exception options).
  </div>
);

export function ExceptionModal({
  open,
  onClose,
  tenantId,
  target,
  subjectLabel,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  /** Exactly one of these should be set — recommendation-scoped or CVE-scoped. */
  target: { recommendationId?: string | null; cveId?: string | null };
  /** Product name or CVE id shown in the dialog subtitle. */
  subjectLabel: string;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCan("operations:write");
  const isCveScoped = !!target.cveId;

  const [scope, setScope] = useState<ExceptionScope>("global");
  const [deviceGroupIds, setDeviceGroupIds] = useState<string[]>([]);
  const [justification, setJustification] = useState<ExceptionJustification>("risk-accepted");
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState<Duration>(90);
  const [customDate, setCustomDate] = useState<Date | null>(null);

  const { data: deviceGroups = [] } = useQuery({
    queryKey: ["device-groups", tenantId],
    queryFn: () => api.get<DeviceGroup[]>(`/api/device-groups?tenantId=${encodeURIComponent(tenantId!)}`),
    enabled: open && !!tenantId,
  });

  const create = useMutation<RecommendationException, Error>({
    mutationFn: () =>
      api.post<RecommendationException>("/api/recommendations/exceptions", {
        tenantId,
        recommendationId: target.recommendationId ?? null,
        cveId: target.cveId ?? null,
        scope,
        deviceGroupIds: scope === "device-group" ? deviceGroupIds : undefined,
        justification,
        notes: notes.trim() || undefined,
        ...(duration === "custom"
          ? { expiresAt: customDate?.toISOString() }
          : { durationDays: duration }),
      }),
    onSuccess: () => {
      // Broad prefix invalidation — an exception can hide rows on any of the
      // filtered surfaces (fleet-wide and per-device, recs and raw CVEs), and
      // also shifts a device's vulnerabilityCount/compliance (adjustForExceptions
      // in data.ts), so the device list/detail header must refresh too.
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["vulnerabilities"] });
      queryClient.invalidateQueries({ queryKey: ["device-recommendations"] });
      queryClient.invalidateQueries({ queryKey: ["device-vulnerabilities"] });
      queryClient.invalidateQueries({ queryKey: ["recommendation-exceptions"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  // Reset when the dialog is re-opened for a different target.
  useEffect(() => {
    if (!open) return;
    setScope("global");
    setDeviceGroupIds([]);
    setJustification(isCveScoped ? "risk-accepted" : "risk-accepted");
    setNotes("");
    setDuration(90);
    setCustomDate(null);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.recommendationId, target.cveId]);

  function toggleGroup(id: string) {
    setDeviceGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const justificationOptions = JUSTIFICATIONS.filter((j) => !j.cveOnly || isCveScoped);
  const maxCustomDate = new Date(Date.now() + MAX_CUSTOM_MS);
  const canSubmit =
    canWrite &&
    !create.isPending &&
    !create.data &&
    !!tenantId &&
    (scope === "global" || deviceGroupIds.length > 0) &&
    (duration !== "custom" || (!!customDate && customDate.getTime() > Date.now()));

  return (
    <SlideOver open={open} onClose={onClose} title="Create exception" subtitle={subjectLabel} elevated>
      {create.data ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            Exception recorded — this will now be hidden from PatchPilot's
            default views until it expires or is cancelled.
          </div>
          {REMINDER}
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {REMINDER}

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Scope
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { id: "global" as const, label: "Global", hint: "Applies tenant-wide" },
                  { id: "device-group" as const, label: "Per device group", hint: "Applies to selected groups only" },
                ]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setScope(opt.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    scope === opt.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="text-xs font-medium">{opt.label}</div>
                  <div className={`mt-0.5 text-[10px] leading-tight ${scope === opt.id ? "text-slate-300" : "text-slate-400"}`}>
                    {opt.hint}
                  </div>
                </button>
              ))}
            </div>

            {scope === "device-group" && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-slate-300 bg-white">
                {deviceGroups.length === 0 ? (
                  <div className="px-3 py-2.5 text-xs text-slate-400">
                    No device groups found for this tenant.
                  </div>
                ) : (
                  deviceGroups.map((g) => {
                    const checked = deviceGroupIds.includes(g.id);
                    return (
                      <label
                        key={g.id}
                        className="flex cursor-pointer items-center gap-2.5 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleGroup(g.id)}
                          className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{g.name}</span>
                      </label>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Justification
            </label>
            <select
              value={justification}
              onChange={(e) => setJustification(e.target.value as ExceptionJustification)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            >
              {justificationOptions.map((j) => (
                <option key={j.value} value={j.value}>
                  {j.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional context for other engineers (ticket reference, mitigation detail, etc.)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Duration
            </label>
            <div className="grid grid-cols-4 gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => setDuration(d.value)}
                  className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors ${
                    duration === d.value
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {duration === "custom" && (
              <div className="mt-2">
                <DateTimePicker value={customDate} onChange={setCustomDate} maxDate={maxCustomDate} />
                <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
                  Custom durations are capped at 1 year.
                </p>
              </div>
            )}
          </div>

          {!canWrite && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Your role doesn't include write access.
            </div>
          )}

          {create.isError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {create.error.message}
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={() => create.mutate()}
              disabled={!canSubmit}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {create.isPending ? "Saving…" : "Create exception"}
            </button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}
