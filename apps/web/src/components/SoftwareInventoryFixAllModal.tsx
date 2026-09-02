import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CHANNEL_SPECS,
  detectMicrosoftStoreInstall,
  selectableChannels,
  type InstallScope,
  type RemediationChannel,
} from "@patchpilot/shared";
import {
  api,
  type DeviceSoftwareInventoryRow,
  type InventoryFixAllResult,
  type SoftwareInventoryDevicesResult,
} from "../lib/api";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import { WingetPicker } from "./FixAllModal";
import { MsStoreChip, ScopeChip, SlideOver } from "./ui";
import {
  defaultWin32DeployOptions,
  Win32DeployOptionsPanel,
  type Win32DeployOptionsValue,
} from "./Win32DeployOptionsPanel";

/**
 * Bulk "Fix All" dialog for the software-inventory surfaces — either every
 * device that has one software title installed (Software Inventory page), or
 * every fixable title on one device (device panel's Inventories tab). Fetches
 * its own target list depending on `target.kind`, then shares the same
 * When/Trigger/Catalog checklist shape as the Devices page's CVE-driven
 * FixAllModal. Posts to /api/software-inventory/fix-all, which re-validates
 * and preflights each selected target server-side and reports back what it
 * skipped and why.
 */

export type InventoryFixAllTarget =
  | { kind: "software"; softwareId: string }
  | { kind: "device"; deviceId: string };

// One row in the confirmation checklist. `key` is device.id when fixing one
// software across devices, or softwareId when fixing one device's inventory
// — mirrors the dual-meaning `label`/`key` fields the /fix-all route uses to
// select + override a subset of its build targets.
interface ChecklistItem {
  key: string;
  label: string;
  sublabel: string;
  installScope: InstallScope;
  isStoreInstall: boolean;
  fixable: boolean;
  wingetPackageId: string | null;
  upToDate: boolean;
}

type WhenMode = "now" | "once";

const WHEN_MODES: { id: WhenMode; label: string }[] = [
  { id: "now", label: "Fix now" },
  { id: "once", label: "Schedule once" },
];

const SCOPE_FILTERS: { value: "all" | InstallScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "machine", label: "SYSTEM" },
  { value: "user", label: "User" },
];

export function SoftwareInventoryFixAllModal({
  open,
  onClose,
  tenantId,
  target,
  title,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  target: InventoryFixAllTarget;
  title: string;
  subtitle?: string;
}) {
  const canWrite = useCan("operations:write");
  const channels = selectableChannels("app");
  const [channel, setChannel] = useState<RemediationChannel>(channels[0]!);
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [packageIds, setPackageIds] = useState<Record<string, string>>({});
  const [scopeFilter, setScopeFilter] = useState<"all" | InstallScope>("all");
  // Win32 deploy-or-reuse options (Channel = "win32-app") — one shared config
  // block applied to every deployed item; name/publisher resolve per-item from
  // the catalog server-side, so this panel hides those fields.
  const [win32DeployOpts, setWin32DeployOpts] = useState<Win32DeployOptionsValue>(
    defaultWin32DeployOptions(),
  );

  const targetKey = target.kind === "software" ? target.softwareId : target.deviceId;

  const devicesQuery = useQuery({
    queryKey: ["software-inventory-devices", target.kind === "software" ? target.softwareId : null, tenantId],
    queryFn: () =>
      api.get<SoftwareInventoryDevicesResult>(
        `/api/software-inventory/${(target as { softwareId: string }).softwareId}/devices?tenantId=${encodeURIComponent(tenantId)}`,
      ),
    enabled: open && target.kind === "software",
  });

  const deviceInventoryQuery = useQuery({
    queryKey: ["device-software-inventory-full", target.kind === "device" ? target.deviceId : null],
    queryFn: () =>
      api
        .get<{ softwareInventory: DeviceSoftwareInventoryRow[] }>(
          `/api/devices/${(target as { deviceId: string }).deviceId}/software-inventory`,
        )
        .then((r) => r.softwareInventory),
    enabled: open && target.kind === "device",
  });

  const isLoading = target.kind === "software" ? devicesQuery.isLoading : deviceInventoryQuery.isLoading;

  const items = useMemo<ChecklistItem[]>(() => {
    if (target.kind === "software") {
      const devices = devicesQuery.data?.devices ?? [];
      return devices
        .filter((d) => d.deviceId)
        .map((d) => ({
          key: d.deviceId as string,
          label: d.hostname,
          sublabel: d.detectedVersion ?? "—",
          installScope: d.installScope,
          isStoreInstall: detectMicrosoftStoreInstall(d.diskPaths, d.registryPaths),
          fixable: d.fixable,
          wingetPackageId: d.wingetPackageId,
          upToDate: d.upToDate,
        }));
    }
    const rows = deviceInventoryQuery.data ?? [];
    return rows.map((r) => ({
      key: r.softwareId,
      label: r.name,
      sublabel: r.version ?? "—",
      installScope: r.installScope,
      isStoreInstall: detectMicrosoftStoreInstall(r.diskPaths, r.registryPaths),
      fixable: !!r.packageSource,
      wingetPackageId: r.wingetPackageId,
      upToDate: r.upToDate,
    }));
  }, [target.kind, devicesQuery.data, deviceInventoryQuery.data]);

  const fixAll = useMutation<InventoryFixAllResult, Error>({
    mutationFn: () => {
      const selectedItems = items
        .filter((i) => selected.has(i.key))
        .map((i) => {
          const pkg = packageIds[i.key]?.trim();
          return pkg ? { key: i.key, packageId: pkg } : { key: i.key };
        });
      return api.post<InventoryFixAllResult>("/api/software-inventory/fix-all", {
        tenantId,
        channel,
        ...(target.kind === "software"
          ? { softwareId: target.softwareId }
          : { deviceId: target.deviceId }),
        items: selectedItems,
        scheduleAt: whenMode === "once" && scheduleAt ? scheduleAt.toISOString() : undefined,
        win32Deploy:
          channel === "win32-app"
            ? {
                runAsAccount: win32DeployOpts.runAsAccount,
                installChoco: win32DeployOpts.installChoco,
                customRepo: win32DeployOpts.customRepo.trim() || undefined,
                customArguments: win32DeployOpts.customArguments.trim() || undefined,
                assignment: {
                  mode: win32DeployOpts.assignmentMode,
                  groupId: win32DeployOpts.groupId || undefined,
                  groupName: win32DeployOpts.groupName.trim() || undefined,
                  excludeGroupId: win32DeployOpts.excludeGroupId || undefined,
                  excludeGroupName: win32DeployOpts.excludeGroupName.trim() || undefined,
                },
              }
            : undefined,
      });
    },
  });

  // Reset the checklist to sensible defaults every time the modal reopens for
  // a (possibly different) target: fixable rows with a known winget package
  // id start checked, everything else starts unchecked with a hint.
  useEffect(() => {
    if (!open) return;
    setChannel(channels[0]!);
    setWhenMode("now");
    setScheduleAt(null);
    setScopeFilter("all");
    setWin32DeployOpts(defaultWin32DeployOptions());
    fixAll.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.kind, targetKey]);

  useEffect(() => {
    if (!open) return;
    const nextSelected = new Set<string>();
    const nextPackageIds: Record<string, string> = {};
    for (const item of items) {
      nextPackageIds[item.key] = item.wingetPackageId ?? "";
      if (item.fixable && item.wingetPackageId && !item.upToDate) nextSelected.add(item.key);
    }
    setSelected(nextSelected);
    setPackageIds(nextPackageIds);
  }, [open, items]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedCount = selected.size;
  const spec = CHANNEL_SPECS[channel];
  const canConfirm =
    canWrite &&
    selectedCount > 0 &&
    !fixAll.isPending &&
    (whenMode !== "once" || (!!scheduleAt && scheduleAt.getTime() > Date.now()));

  const filteredItems = items.filter(
    (i) => scopeFilter === "all" || i.installScope === scopeFilter,
  );

  return (
    <SlideOver open={open} onClose={onClose} title="Fix all" subtitle={`${title}${subtitle ? ` — ${subtitle}` : ""}`} elevated>
      <div className="space-y-5">
        {!fixAll.isSuccess && (
          <>
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

            <div>
              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                2. Trigger method
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
              {channel === "win32-app" && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Win32 app deploy options
                  </div>
                  <Win32DeployOptionsPanel
                    value={win32DeployOpts}
                    onChange={setWin32DeployOpts}
                    source="chocolatey"
                    showNameFields={false}
                    tenantId={tenantId}
                  />
                </div>
              )}
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  3. {target.kind === "software" ? "Devices" : "Software"} ({selectedCount} of {items.length} selected)
                </span>
                {items.length > 0 && (
                  <div className="flex shrink-0 gap-1">
                    {SCOPE_FILTERS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        onClick={() => setScopeFilter(f.value)}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          scopeFilter === f.value
                            ? "bg-slate-900 text-white"
                            : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isLoading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : items.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing to fix.</p>
              ) : (
                <ul className="max-h-80 overflow-y-auto overflow-x-hidden rounded-lg border border-slate-200">
                  {filteredItems.map((item) => {
                    const checked = selected.has(item.key);
                    return (
                      <li
                        key={item.key}
                        className="border-b border-slate-100 px-3 py-2.5 last:border-0"
                      >
                        <div className="flex items-start gap-2.5">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                            checked={checked}
                            disabled={item.upToDate}
                            onChange={() => toggle(item.key)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-medium text-slate-800">
                                {item.label}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <ScopeChip scope={item.installScope} />
                                <MsStoreChip isStoreInstall={item.isStoreInstall} />
                              </div>
                            </div>
                            <div className="text-xs text-slate-400">{item.sublabel}</div>
                            {item.upToDate ? (
                              <p className="mt-1 text-xs text-slate-400">Already up to date.</p>
                            ) : checked ? (
                              <WingetPicker
                                value={packageIds[item.key] ?? ""}
                                onChange={(pkg) =>
                                  setPackageIds((prev) => ({ ...prev, [item.key]: pkg }))
                                }
                              />
                            ) : !item.wingetPackageId ? (
                              <p className="mt-1 text-xs text-amber-600">
                                No winget package mapped — will be skipped unless one is entered.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}

        {!canWrite && !fixAll.isSuccess && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Your role doesn't include remediation write access.
          </div>
        )}

        {fixAll.isError && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {fixAll.error.message}
          </div>
        )}

        {fixAll.isSuccess && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              <p className="text-sm font-medium">
                {fixAll.data.jobsCreated === 0
                  ? "No jobs created — every item was skipped."
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

        {!fixAll.isSuccess && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={() => fixAll.mutate()}
              disabled={!canConfirm}
              className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {fixAll.isPending
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
