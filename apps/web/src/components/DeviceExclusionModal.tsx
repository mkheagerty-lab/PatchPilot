import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Device,
  type DeviceExclusion,
  type DeviceExclusionJustification,
} from "../lib/api";
import {
  DEVICE_EXCLUSION_JUSTIFICATIONS,
  DEVICE_EXCLUSION_JUSTIFICATION_LABELS,
} from "@patchpilot/shared";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import { SlideOver } from "./ui";

/**
 * Records that a device is out of scope — PatchPilot's mirror of the Defender
 * portal's Assets > Devices > Exclude, and the device-level sibling of
 * `ExceptionModal` (which excepts a *finding* rather than a *device*).
 *
 * Same local-only caveat, same non-dismissable reminder: Defender exposes no
 * write API for exclusion — `PATCH /api/machines/{id}` can update only
 * `machineTags` and `deviceValue`, and there is no exclude machine action — so
 * this never reaches Defender and the engineer still has to apply the matching
 * exclusion by hand in the portal.
 *
 * Two deliberate differences from `ExceptionModal`:
 *  - expiry defaults to **Never**, matching Defender, where exclusions don't
 *    expire at all. The duration buttons are an optional review deadline.
 *  - excluding also **blocks remediation** (the `device-excluded` preflight
 *    check), which the confirmation copy says out loud — hiding a device while
 *    still letting a schedule fan out onto it would be the worst of both worlds.
 */

type Duration = "never" | 30 | 60 | 90 | "custom";
const DURATIONS: { value: Duration; label: string }[] = [
  { value: "never", label: "Never" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: "custom", label: "Custom" },
];

const MAX_CUSTOM_MS = 366 * 24 * 60 * 60 * 1000;

/** Defender pops a confirmation when the device has recently reported in. */
const ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;

const REMINDER = (
  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-800">
    <span className="font-semibold">Defender can't be updated via API.</span>{" "}
    Microsoft only supports device exclusion through the Defender portal — this
    record is local to PatchPilot only. You must still exclude the device
    yourself in the Defender portal (Assets → Devices → select the device →
    Exclude).
  </div>
);

export function DeviceExclusionModal({
  open,
  onClose,
  tenantId,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  /** One device for the row action, many for the bulk action bar. */
  devices: Device[];
}) {
  const queryClient = useQueryClient();
  const canWrite = useCan("operations:write");
  const isBulk = devices.length > 1;

  const [justification, setJustification] =
    useState<DeviceExclusionJustification>("out-of-scope");
  const [notes, setNotes] = useState("");
  const [duration, setDuration] = useState<Duration>("never");
  const [customDate, setCustomDate] = useState<Date | null>(null);

  const create = useMutation<{ exclusions: DeviceExclusion[]; skipped: number }, Error>({
    mutationFn: () =>
      api.post<{ exclusions: DeviceExclusion[]; skipped: number }>(
        isBulk ? "/api/device-exclusions/bulk" : "/api/device-exclusions",
        {
          tenantId,
          ...(isBulk
            ? { managedDeviceIds: devices.map((d) => d.managedDeviceId) }
            : { managedDeviceId: devices[0]?.managedDeviceId }),
          justification,
          notes: notes.trim() || undefined,
          ...(duration === "custom"
            ? { expiresAt: customDate?.toISOString() }
            : duration === "never"
              ? {}
              : { durationDays: duration }),
        },
      ),
    onSuccess: () => invalidateExclusionQueries(queryClient),
  });

  // Reset when the dialog is re-opened for a different device or selection.
  useEffect(() => {
    if (!open) return;
    setJustification("out-of-scope");
    setNotes("");
    setDuration("never");
    setCustomDate(null);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, devices.map((d) => d.id).join(",")]);

  // Excluding a machine that's still checking in usually means a mistake —
  // Defender asks for confirmation in exactly this case, so we warn too.
  const activeDevices = devices.filter(
    (d) => d.lastSeen && Date.now() - new Date(d.lastSeen).getTime() < ACTIVE_WITHIN_MS,
  );

  const maxCustomDate = new Date(Date.now() + MAX_CUSTOM_MS);
  const canSubmit =
    canWrite &&
    !create.isPending &&
    !create.data &&
    !!tenantId &&
    devices.length > 0 &&
    (duration !== "custom" || (!!customDate && customDate.getTime() > Date.now()));

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={isBulk ? "Exclude devices" : "Exclude device"}
      subtitle={
        isBulk
          ? `${devices.length} devices selected`
          : (devices[0]?.hostname ?? "")
      }
      elevated
    >
      {create.data ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-700">
            {create.data.exclusions.length === 1
              ? "Device excluded"
              : `${create.data.exclusions.length} devices excluded`}{" "}
            — hidden from PatchPilot's vulnerability, recommendation, inventory
            and catalog views, and blocked from Run Now, Fix Now, Fix All and
            scheduled remediation until the exclusion is stopped.
          </div>
          {create.data.skipped > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {create.data.skipped}{" "}
              {create.data.skipped === 1 ? "device was" : "devices were"} skipped
              — no longer present in this tenant's fleet.
            </div>
          )}
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

          {activeDevices.length > 0 && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2.5 text-xs leading-relaxed text-orange-800">
              <span className="font-semibold">
                {isBulk
                  ? `${activeDevices.length} of these devices ${
                      activeDevices.length === 1 ? "is" : "are"
                    } still active.`
                  : "This device is still active."}
              </span>{" "}
              {isBulk ? "They have" : "It has"} reported in within the last 7
              days. Excluding an active device hides real findings and stops
              PatchPilot from patching it.
            </div>
          )}

          {isBulk && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white">
              {devices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 last:border-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                    {d.hostname}
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{d.os}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Justification
            </label>
            <select
              value={justification}
              onChange={(e) =>
                setJustification(e.target.value as DeviceExclusionJustification)
              }
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            >
              {DEVICE_EXCLUSION_JUSTIFICATIONS.map((j) => (
                <option key={j} value={j}>
                  {DEVICE_EXCLUSION_JUSTIFICATION_LABELS[j]}
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
              placeholder="Optional context for other engineers (ticket reference, decommission date, etc.)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Review date
            </label>
            <div className="grid grid-cols-5 gap-2">
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
            <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
              {duration === "never"
                ? "Defender's exclusions never expire. Set a review date if you want this one to lapse automatically."
                : "The exclusion lapses on this date and the device reappears everywhere."}
            </p>
            {duration === "custom" && (
              <div className="mt-2">
                <DateTimePicker
                  value={customDate}
                  onChange={setCustomDate}
                  maxDate={maxCustomDate}
                />
                <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
                  Custom review dates are capped at 1 year.
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
              {create.isPending
                ? "Saving…"
                : isBulk
                  ? `Exclude ${devices.length} devices`
                  : "Exclude device"}
            </button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}

/**
 * Every query an exclusion can move, invalidated on both create and stop.
 *
 * Much broader than `ExceptionModal`'s five keys: an exception hides one
 * finding, but excluding a device removes it — and its share of every exposure
 * count — from the device list, both fleet-wide finding lists, all four
 * per-device tabs, both inventories, missing KBs, both catalogs and the
 * dashboard's KPIs. Exported so the "Stop exclusion" path can't drift from
 * the create path.
 */
export function invalidateExclusionQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  for (const key of [
    "devices",
    "device-exclusions",
    "vulnerabilities",
    "recommendations",
    "device-vulnerabilities",
    "device-recommendations",
    "device-software-inventory",
    "device-missing-kbs",
    "software-inventory",
    "missing-kbs",
    "catalog",
    "chocolatey-catalog",
    "dashboard",
  ]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}
