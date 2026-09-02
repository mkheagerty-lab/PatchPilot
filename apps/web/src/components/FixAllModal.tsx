import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CHANNEL_SPECS,
  manualRemediationReason,
  routeChannel,
  selectableChannels,
  type InstallScope,
  type RemediationChannel,
} from "@patchpilot/shared";
import { api, type Device, type Severity, type WingetCatalogEntry } from "../lib/api";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import { ManualRemediationTag, MsStoreChip, ScopeChip, SeverityChip } from "./ui";
import { WizardShell } from "./WizardShell";
import {
  defaultWin32DeployOptions,
  Win32DeployOptionsPanel,
  type Win32DeployOptionsValue,
} from "./Win32DeployOptionsPanel";

// Live search-and-pick over the mirrored winget catalog, replacing free-text
// package id entry. Debounced the same way as RunNowModal's picker; each row
// owns its own query/results state since Fix All juggles several software
// items at once.
export function WingetPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (packageId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [pickedName, setPickedName] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: results = [], isLoading } = useQuery<WingetCatalogEntry[]>({
    queryKey: ["winget-search", search],
    queryFn: () =>
      api.get<WingetCatalogEntry[]>(
        `/api/catalog/search?q=${encodeURIComponent(search)}&limit=8`,
      ),
    enabled: !value && search.length >= 2,
  });

  if (value) {
    return (
      <div className="mt-1.5 flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-1">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-slate-700">{value}</div>
          {pickedName && (
            <div className="truncate text-[11px] text-slate-500">{pickedName}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setPickedName(null);
            onChange("");
          }}
          className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the winget catalog…"
        className="w-full rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
      />
      {isLoading ? (
        <div className="mt-1 text-[11px] text-slate-400">Searching…</div>
      ) : results.length > 0 ? (
        <ul className="mt-1 max-h-32 overflow-y-auto rounded border border-slate-200 bg-white">
          {results.map((p) => (
            <li key={p.packageId}>
              <button
                type="button"
                onClick={() => {
                  setPickedName(p.name);
                  setQuery("");
                  setSearch("");
                  onChange(p.packageId);
                }}
                className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-2 py-1 text-left last:border-0 hover:bg-slate-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-slate-800">
                    {p.packageId}
                  </span>
                  <span className="block truncate text-[11px] text-slate-500">
                    {p.name}
                  </span>
                </span>
                {p.latestVersion && (
                  <span className="shrink-0 text-[10px] text-slate-400">
                    v{p.latestVersion}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : search.length >= 2 ? (
        <div className="mt-1 text-[11px] text-slate-400">No catalog match.</div>
      ) : null}
    </div>
  );
}

// No "Automated" tier here — recurring schedules only target patchType +
// severity floor (no device targeting), so a recurring schedule launched
// from one device's Fix All would silently apply tenant-wide.
type WhenMode = "now" | "once";

const WHEN_MODES: { id: WhenMode; label: string }[] = [
  { id: "now", label: "Fix now" },
  { id: "once", label: "Schedule once" },
];

const TRIGGER_CAPTIONS: Partial<Record<RemediationChannel, string>> = {
  "live-response": "Runs straight on each device via the worker.",
  "win32-app":
    "Creates or reuses the Intune Win32 app for each package and syncs devices to pick it up sooner — configure deploy options below.",
};

// One row in the confirmation checklist — the subset of DeviceRunTarget the
// modal actually needs, so Devices.tsx doesn't have to import this file's
// internals to build the list.
export interface FixAllTarget {
  software: string;
  displayName: string;
  severity: Severity;
  cveCount: number;
  wingetRemediable: boolean;
  wingetPackageId: string | null;
  /** Machine-wide vs per-user install — drives the scope filter and the
   * Live Response grey-out below. */
  installScope: InstallScope;
  /** Microsoft Store (UWP/MSIX) install, from disk/registry evidence. */
  isStoreInstall: boolean;
}

const SCOPE_FILTERS: { value: "all" | InstallScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "machine", label: "SYSTEM" },
  { value: "user", label: "User" },
];

export interface FixAllConfirmPayload {
  channel: RemediationChannel;
  items: { software: string; packageId?: string }[];
  scheduleAt?: string;
  /** Channel = "win32-app" only — shared deploy config applied to every
   * deployed row; name/publisher/source resolve per-item server-side. */
  win32Deploy?: {
    displayName?: string;
    description?: string;
    publisher?: string;
    runAsAccount?: "system" | "user";
    installChoco?: boolean;
    customRepo?: string;
    customArguments?: string;
    assignment?: {
      mode: string;
      groupId?: string;
      groupName?: string;
      excludeGroupId?: string;
      excludeGroupName?: string;
    };
  };
}

export function FixAllModal({
  open,
  onClose,
  targets,
  device,
  tenantReadOnly,
  isPending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  targets: FixAllTarget[];
  device: Device | null;
  tenantReadOnly: boolean;
  isPending: boolean;
  error: string | null;
  onConfirm: (payload: FixAllConfirmPayload) => void;
}) {
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [channelOverride, setChannelOverride] = useState<RemediationChannel | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [packageIds, setPackageIds] = useState<Record<string, string>>({});
  const [scopeFilter, setScopeFilter] = useState<"all" | InstallScope>("all");
  // Win32 deploy-or-reuse options (Channel = "win32-app") — one shared config
  // block applied to every deployed row; name/publisher resolve per-item from
  // the catalog server-side, so this panel hides those fields.
  const [win32DeployOpts, setWin32DeployOpts] = useState<Win32DeployOptionsValue>(
    defaultWin32DeployOptions(),
  );

  const canWrite = useCan("operations:write");
  const autoChannel = routeChannel("app", "now");
  const channel = channelOverride ?? autoChannel;
  const triggerOptions = selectableChannels("app");
  const hasUserScopedSelection = targets.some(
    (t) => selected.has(t.software) && t.installScope === "user",
  );

  // Reset the checklist to sensible defaults every time the modal reopens for
  // a (possibly different) device: winget-remediable rows with a known
  // package id start checked, manual-remediation rows stay unchecked (and
  // disabled), everything else starts unchecked with a "needs a package id"
  // hint.
  useEffect(() => {
    if (!open) return;
    setWhenMode("now");
    setScheduleAt(null);
    setChannelOverride(null);
    setWin32DeployOpts(defaultWin32DeployOptions());
    const nextSelected = new Set<string>();
    const nextPackageIds: Record<string, string> = {};
    for (const t of targets) {
      nextPackageIds[t.software] = t.wingetPackageId ?? "";
      if (!manualRemediationReason(t.software) && t.wingetRemediable && t.wingetPackageId) {
        nextSelected.add(t.software);
      }
    }
    setSelected(nextSelected);
    setPackageIds(nextPackageIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, device?.id]);

  const toggle = (software: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(software)) next.delete(software);
      else next.add(software);
      return next;
    });
  };

  const selectedCount = selected.size;
  const spec = CHANNEL_SPECS[channel];
  const canConfirm =
    !tenantReadOnly &&
    canWrite &&
    selectedCount > 0 &&
    !isPending &&
    (whenMode !== "once" || (!!scheduleAt && scheduleAt.getTime() > Date.now()));

  const handleConfirm = () => {
    const items = targets
      .filter((t) => selected.has(t.software))
      .map((t) => {
        const pkg = packageIds[t.software]?.trim();
        return pkg ? { software: t.software, packageId: pkg } : { software: t.software };
      });
    if (items.length === 0) return;
    onConfirm({
      channel,
      items,
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
  };

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="Fix all"
      subtitle={device?.hostname}
    >
      <div className="space-y-5">
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
            {triggerOptions.map((c) => {
              const s = CHANNEL_SPECS[c];
              const active = c === channel;
              const userScopeNote = c === "live-response" && hasUserScopedSelection;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannelOverride(c)}
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
                  {userScopeNote ? (
                    <p className={`mt-0.5 text-xs ${active ? "text-slate-300" : "text-amber-600"}`}>
                      Selected app(s) include per-user installs — Live Response reaches those via
                      a short-lived scheduled task running as the signed-in user (requires someone
                      signed in on the device).
                    </p>
                  ) : (
                    TRIGGER_CAPTIONS[c] && (
                      <p className={`mt-0.5 text-xs ${active ? "text-slate-300" : "text-slate-500"}`}>
                        {TRIGGER_CAPTIONS[c]}
                      </p>
                    )
                  )}
                </button>
              );
            })}
          </div>
          {channelOverride !== null && channelOverride !== autoChannel && (
            <p className="mt-1 text-xs text-amber-600">
              Overriding the default trigger method.
            </p>
          )}
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
                tenantId={device?.tenantId ?? null}
              />
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              3. Affected software ({selectedCount} of {targets.length} selected)
            </span>
            {targets.length > 0 && (
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
          {targets.length === 0 ? (
            <p className="text-sm text-slate-500">
              No winget-remediable software found on this device.
            </p>
          ) : (
            <ul className="overflow-hidden rounded-lg border border-slate-200">
              {targets
                .filter((t) => scopeFilter === "all" || t.installScope === scopeFilter)
                .map((t) => {
                const reason = manualRemediationReason(t.software);
                const disabled = !!reason;
                const checked = selected.has(t.software);
                return (
                  <li
                    key={t.software}
                    className="border-b border-slate-100 px-3 py-2.5 last:border-0"
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggle(t.software)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-slate-800">
                            {t.displayName}
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            <ScopeChip scope={t.installScope} />
                            <MsStoreChip isStoreInstall={t.isStoreInstall} />
                            <SeverityChip severity={t.severity} />
                          </div>
                        </div>
                        <div className="text-xs text-slate-400">
                          {t.cveCount} {t.cveCount === 1 ? "CVE" : "CVEs"}
                        </div>
                        {reason ? (
                          <ManualRemediationTag software={t.software} className="mt-1" />
                        ) : checked ? (
                          <WingetPicker
                            value={packageIds[t.software] ?? ""}
                            onChange={(pkg) =>
                              setPackageIds((prev) => ({
                                ...prev,
                                [t.software]: pkg,
                              }))
                            }
                          />
                        ) : !t.wingetPackageId ? (
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

        {tenantReadOnly && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            This tenant is read-only — remediation dispatch is disabled.
          </div>
        )}

        {!canWrite && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Your role doesn't include remediation write access.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending
              ? whenMode === "once"
                ? "Scheduling…"
                : "Fixing…"
              : whenMode === "once"
                ? `Schedule ${selectedCount || ""} via ${spec.label}`.replace("  ", " ")
                : `Fix ${selectedCount || ""} via ${spec.label}`.replace("  ", " ")}
          </button>
        </div>
      </div>
    </WizardShell>
  );
}
