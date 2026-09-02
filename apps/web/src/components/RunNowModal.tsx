import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CHANNEL_SPECS,
  routeChannel,
  type InstallScope,
  type ManualRemediation,
  type RemediationAction,
  type RemediationChannel,
} from "@patchpilot/shared";
import {
  api,
  ApiError,
  type AltSource,
  type CatalogMatchResult,
  type CatalogPackageLock,
  type ChocolateyCatalogEntry,
  type Device,
  type ExposedDevice,
  type LocalDeviceGroup,
  type LocalDeviceGroupMember,
  type PackageSource,
  type PreflightReport,
  type PreflightStatus,
  type RemediationResult,
  type Schedule,
  type ScriptCatalogEntry,
  type Severity,
  type SoftwareInventoryDevicesResult,
  type WingetCatalogEntry,
} from "../lib/api";
import {
  isDispatchableScript,
  NON_POWERSHELL_REASON,
  SCRIPT_TYPE_LABELS,
} from "../lib/scripts";
import { useCan } from "../lib/auth";
import { DateTimePicker } from "./DateTimePicker";
import {
  defaultRecurrence,
  RecurrencePicker,
  toCron,
  type Recurrence,
} from "./RecurrencePicker";
import { WizardShell } from "./WizardShell";
import {
  defaultWin32DeployOptions,
  Win32DeployOptionsPanel,
  type Win32DeployOptionsValue,
} from "./Win32DeployOptionsPanel";
import { MicrosoftStorePicker, type StoreAppPick } from "./MicrosoftStorePicker";
import {
  defaultStoreAppDeployOptions,
  StoreAppDeployOptionsPanel,
  type StoreAppDeployOptionsValue,
} from "./StoreAppDeployOptionsPanel";

/**
 * The shared "Run now" remediation dialog, opened from the Vulnerabilities
 * Action column, the Winget/Chocolatey Catalog coverage tables and the
 * Devices page. It walks the engineer through: when to run it (Run now /
 * Schedule once — a real future date+time via `scheduleAt` / Automated — an
 * inline recurring schedule, created directly against `/api/schedules`),
 * what remediation option to run (Patch/Update / Uninstall / Manual), which
 * catalog resolves the package or script (Winget / Chocolatey / Script
 * Catalog / curated Microsoft Store), which method delivers it (an
 * overridable choice across the four channels — always defaults to Live
 * Response regardless of timing), and finally a preview of the exact
 * Microsoft call + generated script before dispatch through the existing
 * /api/preflight + /api/remediations contract. Manual remediation is the one
 * branch that skips the Catalog and either dispatches an engineer-supplied
 * script or records a "manually remediated" note with no channel at all.
 * Automated skips the Remediation Option/Catalog/Preview entirely — a
 * recurring schedule is locked to the one software this dialog was opened
 * for (ScheduleTarget.software) and further narrowed by patch type + minimum
 * severity level (plus an optional device group / per-schedule exclude list,
 * defaulting to "All devices"). It never widens to "every app patch" — that
 * broader sweep is only available from Schedules.tsx's own create form. In demo mode execution is
 * simulated; no Microsoft API is called.
 */

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

/** Section 1 — when this run happens. */
type WhenMode = "now" | "once" | "automated";

const WHEN_MODES: { id: WhenMode; label: string }[] = [
  { id: "now", label: "Run now" },
  { id: "once", label: "Schedule once" },
  { id: "automated", label: "Automated" },
];

const SEVERITY_FLOORS: { id: Severity | "none"; label: string }[] = [
  { id: "none", label: "None" },
  { id: "low", label: "Low+" },
  { id: "medium", label: "Medium+" },
  { id: "high", label: "High+" },
  { id: "critical", label: "Critical only" },
];

/** Trigger-method display order — inapplicable channels render greyed, not hidden. */
const TRIGGER_ORDER: RemediationChannel[] = [
  "live-response",
  "expedited-quality-update",
  "win32-app",
  "winget-app",
  "intune-remediation",
];

/** Mockup captions for the trigger cards — what each method actually does. */
const TRIGGER_CAPTIONS: Partial<Record<RemediationChannel, string>> = {
  "live-response": "Runs straight on the device via the worker.",
  "expedited-quality-update":
    "Creates an Intune quality update policy for specific KBs. OS / Update Rings only.",
  "win32-app":
    "Creates or reuses the Intune Win32 app for this package and syncs the device to pick it up sooner — configure deploy options below.",
  "winget-app":
    "Creates or reuses a genuine Microsoft Store app (winGetApp) via Intune and syncs the device to pick it up sooner. Locks Catalog to a live Microsoft Store search below.",
  "intune-remediation":
    "Runs an Intune remediation script policy on-demand. Preview — always reports not performed today.",
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

/** Small "Preview" pill shared by the Chocolatey/Script/Store catalog cards and any preview-availability Channel card. */
function PreviewBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
        active ? "bg-white/15 text-slate-100" : "bg-amber-100 text-amber-700"
      }`}
    >
      Preview
    </span>
  );
}

/**
 * Extracts the specific failing check's detail from a 422's parsed body
 * (`{ error, report }`, see jobs.ts's single-device remediation route) so a
 * batch Fix Now dispatch can show the engineer the real reason — e.g. the
 * install-scope check's explanation — instead of a generic gate message.
 */
function failingCheckDetail(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const report = (data as { report?: PreflightReport }).report;
  const failed = report?.checks?.find((c) => c.status === "fail");
  return failed?.detail ?? null;
}

/**
 * Substitutes the device identifiers into a channel's endpoint template so the
 * engineer sees the exact Microsoft call this run will make — the honest "Graph
 * Call Preview". Unknown ids stay as their `{token}` placeholder.
 */
function previewEndpoint(channel: RemediationChannel, device?: Device): string {
  const spec = CHANNEL_SPECS[channel];
  const host = spec.host === "graph" ? "https://graph.microsoft.com/v1.0" : "https://api.securitycenter.microsoft.com";
  const path = spec.endpointTemplate
    .replace("{id}", device?.managedDeviceId ?? "{id}")
    .replace("{machineId}", device?.defenderMachineId ?? "{machineId}");
  // endpointTemplate is "VERB /path"; splice the host before the path.
  const [verb, ...rest] = path.split(" ");
  return `${verb} ${host}${rest.join(" ")}`;
}

/**
 * The JSON body the channel's Microsoft call carries, mirroring what the worker
 * actually sends (Live Response) or would need to create (EQU / Win32). Shown
 * beside the endpoint so the preview is a complete, copyable request.
 */
function previewBody(
  channel: RemediationChannel,
  opts: {
    software: string;
    patchType: "app" | "os";
    packageId: string | null;
    installScope?: InstallScope;
    action?: RemediationAction;
    source?: PackageSource | null;
  },
): string {
  switch (channel) {
    case "live-response": {
      const basePackageArg = opts.packageId ?? opts.software;
      // Chocolatey has no per-user App-Execution-Alias problem — it always
      // installs machine-wide — so its library script takes a plain
      // "upgrade <id>" (upgrade-only, no uninstall, no scheduled-task-as-user
      // routing), unlike the generic winget script below. Mirrors the actual
      // dispatch in runLiveResponseChocolateyRemediation (live-response.ts).
      if (opts.patchType === "app" && opts.source === "chocolatey") {
        const args = `upgrade ${basePackageArg}`;
        return JSON.stringify(
          {
            Commands: [
              {
                type: "RunScript",
                params: [
                  { key: "ScriptName", value: "PatchPilot-Chocolatey-<content-hash>.ps1" },
                  { key: "Args", value: args },
                ],
              },
            ],
            Comment: `PatchPilot Run Now — ${opts.software}`,
          },
          null,
          2,
        );
      }
      const uninstall = opts.patchType === "app" && opts.action === "uninstall";
      const verb = uninstall ? "uninstall" : "upgrade";
      // A per-user install adds a trailing Args token that routes the library
      // script through the scheduled-task-as-logged-in-user path instead of
      // the direct-SYSTEM call — see LiveResponseInput.installScope. The verb
      // prefix only applies to the winget path (patchType "app"): one generic
      // library script now handles every winget verb PatchPilot invokes there,
      // but the OS/WUA script below is unrelated and keeps its own Args shape.
      const args =
        opts.patchType !== "app"
          ? basePackageArg
          : opts.installScope === "user"
            ? `${verb} ${basePackageArg} user`
            : `${verb} ${basePackageArg}`;
      return JSON.stringify(
        {
          Commands: [
            {
              type: "RunScript",
              params: [
                {
                  key: "ScriptName",
                  value:
                    opts.patchType === "os" ? "PatchPilot-WUA-Install.ps1" : "PatchPilot-Winget-<content-hash>.ps1",
                },
                { key: "Args", value: args },
              ],
            },
          ],
          Comment: `PatchPilot Run Now — ${opts.software}${uninstall ? " (uninstall)" : ""}`,
        },
        null,
        2,
      );
    }
    case "expedited-quality-update":
      return JSON.stringify(
        {
          displayName: `Expedite ${opts.software}`,
          expediteSettings: {
            qualityUpdateRelease: "<KB release id>",
            daysUntilForcedReboot: 2,
          },
          assignments: [{ target: { groupId: "<aad-group-id>" } }],
        },
        null,
        2,
      );
    default:
      // Win32 app / Intune remediation: the sync/trigger call itself carries no
      // body — the app package (or remediation script assignment) is created
      // first, then the device is synced/triggered to pick it up.
      return "{}";
  }
}

/** Display labels for the alternate repos a not-supported app can be driven through. */
const SOURCE_LABELS: Record<PackageSource, string> = {
  chocolatey: "Chocolatey",
  "microsoft-store": "Microsoft Store",
};

/** Section 2 — what kind of remediation this run is. */
type RemediationOption = "patch" | "uninstall" | "manual";

/** Section 3 — which catalog resolves the package (only meaningful when remediationOption !== "manual"). */
type Catalog = "winget" | "chocolatey" | "script" | "microsoft-store" | "microsoft-store-app";

/** Manual remediation option's two sub-flows. */
type ManualMode = "dispatch" | "record";

/**
 * Per-device result of a batch run. Each selected device gets its own
 * /api/remediations dispatch; we settle them independently so one device's
 * gate failure never sinks the others' successful queue-ups.
 */
type BatchOutcome =
  | { deviceId: string; hostname: string; ok: true; result: RemediationResult }
  | { deviceId: string; hostname: string; ok: false; error: string };

/** Per-device result of a batch "mark as manually remediated" — mirrors BatchOutcome. */
type ManualRecordOutcome =
  | { deviceId: string; hostname: string; ok: true; record: ManualRemediation }
  | { deviceId: string; hostname: string; ok: false; error: string };

/**
 * The winget catalog search sub-UI shared by the Patch and Uninstall
 * remediation options — both drive the same winget search state (see
 * `overridePackageId` in RunNowModal), so they share one picker instead of
 * two copies that could drift apart.
 */
function WingetPicker({
  wingetPick,
  setWingetPick,
  wingetQuery,
  setWingetQuery,
  wingetResults,
  wingetSearching,
  wingetSearch,
}: {
  wingetPick: CatalogPackageLock | null;
  setWingetPick: (p: CatalogPackageLock | null) => void;
  wingetQuery: string;
  setWingetQuery: (q: string) => void;
  wingetResults: WingetCatalogEntry[];
  wingetSearching: boolean;
  wingetSearch: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      {wingetPick ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-slate-800">
              {wingetPick.packageId}
            </div>
            <div className="truncate text-[11px] text-slate-500">
              {wingetPick.name}
              {wingetPick.latestVersion
                ? ` · v${wingetPick.latestVersion}`
                : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setWingetPick(null)}
            className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={wingetQuery}
            onChange={(e) => setWingetQuery(e.target.value)}
            placeholder="Search the winget catalog…"
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          {wingetSearching ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              Searching…
            </div>
          ) : wingetResults.length > 0 ? (
            <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
              {wingetResults.map((p) => (
                <li key={p.packageId}>
                  <button
                    type="button"
                    onClick={() => setWingetPick(p)}
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-2.5 py-1.5 text-left last:border-0 hover:bg-slate-50"
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
          ) : wingetSearch.length >= 2 ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              No catalog match — PatchPilot's stored mapping for
              this CVE will be used if one exists.
            </div>
          ) : null}
          <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
            No selection — the CVE's stored winget match is used.
            Pick a package to override it.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The Chocolatey catalog search sub-UI for Catalog = "Chocolatey" — mirrors
 * `WingetPicker` exactly (locked summary + Clear vs. live search), backed by
 * `/api/chocolatey-catalog/search` instead of the winget mirror.
 */
function ChocolateyPicker({
  chocoPick,
  setChocoPick,
  chocoQuery,
  setChocoQuery,
  chocoResults,
  chocoSearching,
  chocoSearch,
}: {
  chocoPick: CatalogPackageLock | null;
  setChocoPick: (p: CatalogPackageLock | null) => void;
  chocoQuery: string;
  setChocoQuery: (q: string) => void;
  chocoResults: ChocolateyCatalogEntry[];
  chocoSearching: boolean;
  chocoSearch: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      {chocoPick ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-slate-800">
              {chocoPick.packageId}
            </div>
            <div className="truncate text-[11px] text-slate-500">
              {chocoPick.name}
              {chocoPick.latestVersion ? ` · v${chocoPick.latestVersion}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setChocoPick(null)}
            className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          <input
            type="text"
            value={chocoQuery}
            onChange={(e) => setChocoQuery(e.target.value)}
            placeholder="Search the Chocolatey catalog…"
            className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          {chocoSearching ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              Searching…
            </div>
          ) : chocoResults.length > 0 ? (
            <ul className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
              {chocoResults.map((p) => (
                <li key={p.packageId}>
                  <button
                    type="button"
                    onClick={() => setChocoPick(p)}
                    className="flex w-full items-center justify-between gap-2 border-b border-slate-100 px-2.5 py-1.5 text-left last:border-0 hover:bg-slate-50"
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
          ) : chocoSearch.length >= 2 ? (
            <div className="mt-1.5 text-[11px] text-slate-400">
              No catalog match — enter the exact Chocolatey package id below
              if you know it.
            </div>
          ) : null}
          <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
            No selection — PatchPilot's live Chocolatey match is used. Pick a
            package to override it.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The Script Catalog sub-UI for Catalog = "Script" — pick one uploaded
 * script to dispatch verbatim through the Intune (Platform/Remediation
 * Script) Channel. Intune-only, preview quality (see ScriptCatalog.tsx).
 */
function ScriptPicker({
  scripts,
  scriptPick,
  setScriptPick,
  loading,
  channel,
}: {
  scripts: ScriptCatalogEntry[];
  scriptPick: ScriptCatalogEntry | null;
  setScriptPick: (s: ScriptCatalogEntry | null) => void;
  loading: boolean;
  channel: RemediationChannel;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      {scriptPick ? (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-slate-800">
              {scriptPick.name}
            </div>
            {scriptPick.description && (
              <div className="truncate text-[11px] text-slate-500">
                {scriptPick.description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setScriptPick(null)}
            className="shrink-0 text-[11px] font-medium text-slate-500 hover:text-slate-800"
          >
            Clear
          </button>
        </div>
      ) : loading ? (
        <div className="text-[11px] text-slate-400">Loading scripts…</div>
      ) : scripts.length === 0 ? (
        <div className="text-[11px] text-slate-400">
          No scripts uploaded yet for this tenant.
        </div>
      ) : (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white">
          {scripts.map((s) => {
            // Shown but not selectable rather than filtered out: an engineer who
            // just uploaded a .sh should see it here with the reason, not wonder
            // where it went.
            const dispatchable = isDispatchableScript(s.scriptType);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setScriptPick(s)}
                  disabled={!dispatchable}
                  title={
                    dispatchable
                      ? undefined
                      : NON_POWERSHELL_REASON
                  }
                  className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-2.5 py-1.5 text-left last:border-0 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  <span className="flex w-full items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-slate-800">
                      {s.name}
                    </span>
                    <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                      {SCRIPT_TYPE_LABELS[s.scriptType]}
                    </span>
                  </span>
                  {s.description && (
                    <span className="truncate text-[11px] text-slate-500">
                      {s.description}
                    </span>
                  )}
                  {!dispatchable && (
                    <span className="text-[11px] text-amber-600">{NON_POWERSHELL_REASON}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
        {channel === "win32-app"
          ? "Dispatch runs through Intune (Win32 app) — creates or reuses a Win32 app that runs this script."
          : "Dispatch always runs through Intune (Platform/Remediation Script)."}{" "}
        <Link
          to="/catalog/scripts"
          className="font-medium text-slate-600 underline-offset-2 hover:underline"
        >
          Manage scripts →
        </Link>
      </p>
    </div>
  );
}

export function RunNowModal({
  open,
  onClose,
  vulnId,
  softwareId,
  software,
  displayName,
  patchType,
  tenantId,
  tenantReadOnly,
  altSources = [],
  lockedDevice = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Highest-severity finding id for the software group this run seeds from. */
  vulnId: string;
  /**
   * When set, this run targets a Software Inventory row instead of a CVE
   * finding — preflight/dispatch hit `/api/software-inventory/{preflight,fix}`
   * keyed by this id instead of `/api/{preflight,remediations}` keyed by
   * `vulnId`. Always paired with `lockedDevice`, since inventory Fix Now is
   * always scoped to the one device the engineer drilled into.
   */
  softwareId?: string;
  software: string;
  /** Marketing-friendly label for the dialog subtitle only; falls back to `software`. */
  displayName?: string;
  patchType: "app" | "os";
  tenantId: string | null;
  tenantReadOnly: boolean;
  /**
   * For a not-supported app (winget has no package), the alternate repos
   * PatchPilot can still drive the fix through. Used to pre-fill the Chocolatey
   * package id and to offer the Microsoft Store option when curated.
   */
  altSources?: AltSource[];
  /**
   * When set, the run is scoped to exactly this one device — opened from the
   * Devices page, where the engineer is already looking at a single machine and
   * picking which of its applications to remediate. The picker is locked to it
   * and the tenant-wide exposed-devices lookup is skipped. When null (default),
   * the dialog self-scopes to every device exposed to the finding's software.
   */
  lockedDevice?: Device | null;
}) {
  // Server-enforced boundary is `operations:write` on the dispatch routes
  // themselves — this only keeps the dialog from offering a button the API
  // will 403 anyway.
  const canWrite = useCan("operations:write");
  const isInventoryMode = Boolean(softwareId);
  // Groups everything below (reset effect, re-preflight effect, mutation
  // dependency arrays) that used to re-key off `vulnId` alone — now keys off
  // whichever id actually identifies this run's target.
  const targetKey = softwareId ?? vulnId;

  const { data: allDevices = [] } = useQuery<Device[]>({
    queryKey: ["devices", tenantId],
    queryFn: () => api.get<Device[]>(`/api/devices?tenantId=${tenantId}`),
    enabled: open && !!tenantId && !lockedDevice,
  });

  // The devices actually exposed to THIS finding's software — the same
  // (tenant, software) → exposed-devices join the catalog drill-down uses. The
  // picker must offer only affected machines, never the whole tenant fleet.
  // CVE-oriented only; inventory mode uses the query below instead.
  const { data: exposedRaw = [], isLoading: exposedLoading } = useQuery<
    ExposedDevice[]
  >({
    queryKey: ["run-now-exposed", tenantId, software],
    queryFn: () =>
      api.get<ExposedDevice[]>(
        `/api/recommendations/exposed-devices?tenantId=${encodeURIComponent(
          tenantId!,
        )}&software=${encodeURIComponent(software)}`,
      ),
    enabled: open && !!tenantId && !!software && !lockedDevice && !isInventoryMode,
  });

  // The devices carrying THIS inventory software row — the authoritative
  // multi-device list for a Fix All from Inventories, keyed by softwareId
  // rather than a CVE exposure join.
  const { data: inventoryDevicesRaw, isLoading: inventoryDevicesLoading } =
    useQuery<SoftwareInventoryDevicesResult>({
      queryKey: ["run-now-inventory-devices", tenantId, softwareId],
      queryFn: () =>
        api.get<SoftwareInventoryDevicesResult>(
          `/api/software-inventory/${softwareId}/devices?tenantId=${encodeURIComponent(
            tenantId!,
          )}`,
        ),
      enabled: open && !!tenantId && !!softwareId && !lockedDevice && isInventoryMode,
    });

  // Resolve exposed/inventory entries back to full Device rows (we need `id`,
  // `os`, the Intune/Defender ids). CVE mode matches on the Defender machine
  // id — the exposure join key — with a hostname fallback for Intune-only
  // devices that carry no machine id but still appear by name. Inventory mode
  // joins on `deviceId`, which already equals `Device.id` directly. When
  // opened from the Devices page the run is already pinned to one machine, so
  // we skip the join entirely.
  const devices = useMemo(() => {
    if (lockedDevice) return [lockedDevice];
    if (isInventoryMode) {
      const ids = new Set(
        (inventoryDevicesRaw?.devices ?? []).map((d) => d.deviceId),
      );
      return allDevices.filter((d) => ids.has(d.id));
    }
    const machineIds = new Set(
      exposedRaw
        .map((e) => e.defenderMachineId)
        .filter((x): x is string => !!x),
    );
    const names = new Set(exposedRaw.map((e) => e.deviceName));
    return allDevices.filter(
      (d) =>
        (d.defenderMachineId && machineIds.has(d.defenderMachineId)) ||
        names.has(d.hostname),
    );
  }, [allDevices, exposedRaw, inventoryDevicesRaw, isInventoryMode, lockedDevice]);

  // The devices this run targets. One remediation is dispatched per selected
  // device; the pre-flight gate is previewed against the first (representative)
  // one, since the generated script and licensing/read-only checks are identical
  // across devices in the same tenant.
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  // 1. When — Run now / Schedule once (a real future scheduleAt) / Automated
  // (creates a recurring schedules row inline). Auto-routing no longer varies
  // by this — routeChannel() always returns Live Response regardless.
  const [whenMode, setWhenMode] = useState<WhenMode>("now");
  const [scheduleAt, setScheduleAt] = useState<Date | null>(null);
  const [recurrence, setRecurrence] = useState<Recurrence>(defaultRecurrence());
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleSeverity, setScheduleSeverity] = useState<Severity | "none">("low");
  // Device targeting for the Automated schedule — mirrors ScheduleTarget in
  // packages/shared/src/schedules.ts. Empty group id = "All devices" (the
  // default); excludes are only meaningful once a group is picked, same as
  // Schedules.tsx's own targeting UI.
  const [scheduleDeviceGroupId, setScheduleDeviceGroupId] = useState("");
  const [scheduleExcludedDeviceIds, setScheduleExcludedDeviceIds] = useState<string[]>([]);
  // 3. Channel — engineer override of the auto-routed channel. Null = follow
  // the route; resets whenever the When mode changes.
  const [channelOverride, setChannelOverride] =
    useState<RemediationChannel | null>(null);
  // 2. Remediation Option — Patch/Update (default), Uninstall, or Manual.
  // OS findings are always forced to "patch" (WUA auto-script) — see the
  // "reset on reopen" effect and the disabled Uninstall/Manual cards below.
  const [remediationOption, setRemediationOption] = useState<RemediationOption>("patch");
  // 3. Catalog — independent of remediationOption, only rendered for apps
  // when remediationOption !== "manual".
  const [catalog, setCatalog] = useState<Catalog>("winget");
  // Manual's two sub-flows and their inputs.
  const [manualMode, setManualMode] = useState<ManualMode>("dispatch");
  const [manualScriptText, setManualScriptText] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  // Winget picker: live search over the mirrored catalog. Locked to a real
  // auto-match by default (see the catalogMatch effect below) — search only
  // surfaces once the engineer clears it or no auto-match exists.
  const [wingetPick, setWingetPick] = useState<CatalogPackageLock | null>(null);
  const [wingetQuery, setWingetQuery] = useState("");
  const [wingetSearch, setWingetSearch] = useState("");
  // Chocolatey picker: mirrors the winget picker exactly (locked auto-match +
  // clear-to-search), backed by /api/chocolatey-catalog/search.
  const [chocoPick, setChocoPick] = useState<CatalogPackageLock | null>(null);
  const [chocoQuery, setChocoQuery] = useState("");
  const [chocoSearch, setChocoSearch] = useState("");
  // Script Catalog selection (Catalog = "Script").
  const [scriptPick, setScriptPick] = useState<ScriptCatalogEntry | null>(null);
  // Win32 deploy-or-reuse options (Channel = "win32-app") — configured inline
  // instead of on a separate Deploy App dialog.
  const [win32DeployOpts, setWin32DeployOpts] = useState<Win32DeployOptionsValue>(
    defaultWin32DeployOptions(),
  );
  // Microsoft Store app picker (Catalog = "microsoft-store-app", forced by
  // Channel = "winget-app") — no CVE-stored auto-match exists, so this always
  // starts empty; MicrosoftStorePicker owns its own live-search debounce.
  const [storeAppPick, setStoreAppPick] = useState<StoreAppPick | null>(null);
  const [storeAppQuery, setStoreAppQuery] = useState("");
  // Microsoft Store app deploy-or-reuse options — mirrors win32DeployOpts.
  const [storeAppDeployOpts, setStoreAppDeployOpts] = useState<StoreAppDeployOptionsValue>(
    defaultStoreAppDeployOptions(),
  );
  const [copied, setCopied] = useState(false);
  const [showQueuedScript, setShowQueuedScript] = useState(false);

  const isAutomated = whenMode === "automated";

  // Device targeting for the Automated tab — same PatchPilot-native device
  // groups Schedules.tsx's own targeting UI reads/writes.
  const { data: scheduleGroups = [] } = useQuery<LocalDeviceGroup[]>({
    queryKey: ["device-groups", tenantId],
    queryFn: () => api.get<LocalDeviceGroup[]>(`/api/local-device-groups?tenantId=${tenantId}`),
    enabled: open && isAutomated && !!tenantId,
  });
  const { data: scheduleGroupMembers = [] } = useQuery<LocalDeviceGroupMember[]>({
    queryKey: ["device-group-members", scheduleDeviceGroupId, tenantId],
    queryFn: () =>
      api.get<LocalDeviceGroupMember[]>(
        `/api/local-device-groups/${scheduleDeviceGroupId}/members?tenantId=${tenantId}`,
      ),
    enabled: open && isAutomated && !!scheduleDeviceGroupId && !!tenantId,
  });

  // OS findings here are CVE-based (no missing-KB id) — Live Response's WUA
  // path and Win32/Intune both need one, so Expedited Quality Update is the
  // only channel actually wired up for an OS-patchType finding in this dialog.
  const autoChannel =
    patchType === "os" ? "expedited-quality-update" : routeChannel(patchType, "now");
  const channel = channelOverride ?? autoChannel;
  // True once the engineer has actually picked a different channel than the
  // auto-route would.
  const triggerOverridden = channelOverride !== null && channelOverride !== autoChannel;
  // Catalog = Script force-locks the Channel to Intune (Platform/Remediation
  // Script) — Script Catalog dispatch is Intune-only for now.
  const methodLocked = remediationOption !== "manual" && catalog === "script";
  // What the API contract calls `source`: null = winget/WUA/script, else the
  // alt repo. Uninstall and Script Catalog have no source-driven path, so
  // they stay null here too.
  const source: PackageSource | null =
    remediationOption === "manual"
      ? null
      : catalog === "chocolatey"
        ? "chocolatey"
        : catalog === "microsoft-store"
          ? "microsoft-store"
          : null;
  // True whenever the "4. Catalog" picker is actually on screen (app finding,
  // not Manual) — i.e. the engineer made a real catalog choice, even when that
  // choice is Winget/Script Catalog and so `source` above is null. Lets the
  // backend tell "engineer picked Winget" apart from "no catalog step shown at
  // all" (Manual, OS findings), both of which serialize `source` as null —
  // without this, the per-user-install auto-route-to-Chocolatey heuristic
  // can't distinguish the two and silently overrides an explicit Winget pick.
  const sourceExplicit = remediationOption !== "manual" && patchType === "app";
  // "upgrade" (default) or "uninstall" — the 2nd Remediation Option.
  const action: RemediationAction = remediationOption === "uninstall" ? "uninstall" : "upgrade";
  // Engineer-selected package id override sent to preflight + run. Winget pick
  // overrides the CVE's stored mapping (shared by Uninstall, which reuses the
  // same winget catalog picker); Chocolatey pick overrides the curated alt
  // id the same way. Null for Script/Microsoft Store/Manual — those resolve
  // through manualScript or the curated alt map instead.
  const overridePackageId =
    remediationOption !== "manual" && catalog === "winget"
      ? wingetPick?.packageId ?? null
      : remediationOption !== "manual" && catalog === "chocolatey"
        ? chocoPick?.packageId ?? null
        : remediationOption !== "manual" && catalog === "microsoft-store-app"
          ? storeAppPick?.packageId ?? null
          : null;
  // An engineer-supplied script that replaces the generated remediation
  // script entirely (Workstream 3's `manualScript` contract): either the
  // Manual option's own "dispatch" sub-mode, or a Script Catalog pick.
  const effectiveManualScript =
    remediationOption === "manual" && manualMode === "dispatch"
      ? manualScriptText.trim() || null
      : remediationOption !== "manual" && catalog === "script"
        ? scriptPick?.scriptContent.trim() || null
        : null;
  const needsManualScript =
    (remediationOption === "manual" && manualMode === "dispatch") ||
    (remediationOption !== "manual" && catalog === "script");

  // Channel = Win32 app: create-or-reuse the Intune app inline at dispatch
  // time instead of requiring a separate Deploy App step first. Undefined
  // (nothing sent) for Microsoft Store — that catalog pick has no Win32
  // wrapper path — and for Manual, which has no catalog at all. A Script
  // Catalog pick sends this *alongside* `effectiveManualScript` above: the
  // script content satisfies preflight/records the job's script column, while
  // this block tells the server which Win32 app to create-or-reuse and
  // assign around it.
  //
  // packageId is only required client-side for a Script Catalog pick — there
  // is no server-side fallback for "script" (a script is never a CVE's own
  // stored match, only an explicit pick). For winget/chocolatey it's sent
  // when the engineer picked an override (or the live catalog auto-match
  // resolved one), but is otherwise omitted so the server falls back to the
  // same effectiveWingetId/altPackageId the preflight/generated-script above
  // already resolved from the CVE's own stored match — this is the common
  // case (engineer never touches the "4. Catalog" picker at all), and used
  // to silently no-op the whole deploy because this block required a
  // client-side pick that was never made.
  const win32DeployPackageId =
    catalog === "winget"
      ? wingetPick?.packageId ?? null
      : catalog === "chocolatey"
        ? chocoPick?.packageId ?? null
        : catalog === "script"
          ? scriptPick?.id ?? null
          : null;
  const win32Deploy =
    channel === "win32-app" &&
    remediationOption !== "manual" &&
    catalog !== "microsoft-store" &&
    catalog !== "microsoft-store-app" &&
    (catalog !== "script" || win32DeployPackageId)
      ? {
          source: catalog,
          packageId: win32DeployPackageId ?? undefined,
          displayName: win32DeployOpts.displayName.trim() || undefined,
          description: win32DeployOpts.description.trim() || undefined,
          publisher: win32DeployOpts.publisher.trim() || undefined,
          runAsAccount: win32DeployOpts.runAsAccount,
          installChoco: catalog === "chocolatey" ? win32DeployOpts.installChoco : undefined,
          customRepo:
            catalog === "chocolatey" ? win32DeployOpts.customRepo.trim() || undefined : undefined,
          customArguments: win32DeployOpts.customArguments.trim() || undefined,
          assignment: {
            mode: win32DeployOpts.assignmentMode,
            groupId: win32DeployOpts.groupId || undefined,
            groupName: win32DeployOpts.groupName.trim() || undefined,
            excludeGroupId: win32DeployOpts.excludeGroupId || undefined,
            excludeGroupName: win32DeployOpts.excludeGroupName.trim() || undefined,
          },
        }
      : undefined;

  // Mirrors win32Deploy's shape for the winget-app channel — matches the
  // backend's WinGetAppDeployBody contract (apps/api/src/routes/jobs.ts).
  // No "source" or packageId-from-catalog-pick fallback: this channel has
  // exactly one source (a live Store search pick), so storeAppPick is
  // required, not derived from `catalog` the way win32Deploy's packageId is.
  const storeAppDeploy =
    channel === "winget-app" && remediationOption !== "manual" && storeAppPick
      ? {
          packageId: storeAppPick.packageId,
          displayName: storeAppDeployOpts.displayName.trim() || undefined,
          description: storeAppDeployOpts.description.trim() || undefined,
          publisher: storeAppDeployOpts.publisher.trim() || undefined,
          runAsAccount: storeAppDeployOpts.runAsAccount,
          assignment: {
            mode: storeAppDeployOpts.assignmentMode,
            groupId: storeAppDeployOpts.groupId || undefined,
            groupName: storeAppDeployOpts.groupName.trim() || undefined,
            excludeGroupId: storeAppDeployOpts.excludeGroupId || undefined,
            excludeGroupName: storeAppDeployOpts.excludeGroupName.trim() || undefined,
          },
        }
      : undefined;

  // Preview the gate/script against the first selected device. `deviceKey` gives
  // effects a stable primitive to depend on so any change to the selection set
  // re-previews and clears a stale batch result.
  const primaryDeviceId = deviceIds[0] ?? "";
  const deviceKey = deviceIds.join(",");
  const device = devices.find((d) => d.id === primaryDeviceId);
  const storeAlt = altSources.find((a) => a.source === "microsoft-store");

  // Debounce the winget search so typing doesn't hammer the catalog endpoint.
  useEffect(() => {
    const t = setTimeout(() => setWingetSearch(wingetQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [wingetQuery]);

  const { data: wingetResults = [], isLoading: wingetSearching } = useQuery<
    WingetCatalogEntry[]
  >({
    queryKey: ["winget-search", wingetSearch],
    queryFn: () =>
      api.get<WingetCatalogEntry[]>(
        `/api/catalog/search?q=${encodeURIComponent(wingetSearch)}&limit=8`,
      ),
    enabled:
      open &&
      patchType === "app" &&
      remediationOption !== "manual" &&
      catalog === "winget" &&
      wingetSearch.length >= 2,
  });

  // Debounce the Chocolatey search — mirrors the winget one above.
  useEffect(() => {
    const t = setTimeout(() => setChocoSearch(chocoQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [chocoQuery]);

  const { data: chocoResults = [], isLoading: chocoSearching } = useQuery<
    ChocolateyCatalogEntry[]
  >({
    queryKey: ["chocolatey-search", chocoSearch],
    queryFn: () =>
      api.get<ChocolateyCatalogEntry[]>(
        `/api/chocolatey-catalog/search?q=${encodeURIComponent(chocoSearch)}&limit=8`,
      ),
    enabled:
      open &&
      patchType === "app" &&
      remediationOption !== "manual" &&
      catalog === "chocolatey" &&
      chocoSearch.length >= 2,
  });

  // Fills the required Publisher field from a fresh Store pick when the
  // engineer hasn't already typed one — there's no CVE-stored default to
  // seed it from (unlike win32DeployOpts, which only ever seeds displayName
  // from the software title on open).
  useEffect(() => {
    if (!storeAppPick) return;
    setStoreAppDeployOpts((prev) =>
      prev.publisher.trim() ? prev : { ...prev, publisher: storeAppPick.publisher },
    );
  }, [storeAppPick]);

  // Live auto-match for both catalogs against this run's software title —
  // powers the "locks in" default for WingetPicker/ChocolateyPicker below.
  // Resolved by (tenantId, software) only, same as the coverage/inventory
  // matchers, so it applies identically in CVE mode and inventory mode.
  const { data: catalogMatch } = useQuery<CatalogMatchResult>({
    queryKey: ["catalog-match", tenantId, software],
    queryFn: () =>
      api.get<CatalogMatchResult>(
        `/api/catalog/match?tenantId=${encodeURIComponent(tenantId!)}&software=${encodeURIComponent(software)}`,
      ),
    enabled: open && !!tenantId && !!software && patchType === "app",
  });

  // Applies catalogMatch (and, for Chocolatey, falls back to the curated
  // altSources map when no live match exists) exactly once per dialog open —
  // a ref rather than a `wingetPick === null` guard so that clicking Clear
  // during this same open session never gets silently re-locked if the query
  // refetches in the background.
  const autoMatchAppliedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    autoMatchAppliedRef.current = false;
  }, [open, targetKey]);

  useEffect(() => {
    if (!open || !catalogMatch || autoMatchAppliedRef.current) return;
    autoMatchAppliedRef.current = true;
    if (catalogMatch.winget) setWingetPick(catalogMatch.winget);
    if (catalogMatch.chocolatey) {
      setChocoPick(catalogMatch.chocolatey);
    } else {
      const curated = altSources.find((a) => a.source === "chocolatey");
      if (curated) {
        setChocoPick({ packageId: curated.packageId, name: curated.name, latestVersion: null });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalogMatch]);

  // Always active-only: an archived script is one an engineer deliberately took
  // out of circulation, so it must never be dispatchable. The `false` in the key
  // matches the Script Catalog page's showArchived discriminator, so the two
  // share a cache entry when the page is showing active scripts and diverge
  // when it isn't.
  const { data: scripts = [], isLoading: scriptsLoading } = useQuery<ScriptCatalogEntry[]>({
    queryKey: ["script-catalog", tenantId, false],
    queryFn: () =>
      api.get<ScriptCatalogEntry[]>(
        `/api/script-catalog?tenantId=${encodeURIComponent(tenantId ?? "")}&includeArchived=false`,
      ),
    enabled:
      open && !!tenantId && patchType === "app" && remediationOption !== "manual" && catalog === "script",
  });

  function toggleDevice(id: string) {
    setDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const preflight = useMutation<PreflightReport, Error>({
    mutationFn: () =>
      isInventoryMode
        ? api.post<PreflightReport>("/api/software-inventory/preflight", {
            tenantId,
            softwareId,
            deviceId: primaryDeviceId,
            channel,
            source,
            sourceExplicit,
            packageId: overridePackageId ?? undefined,
            action,
            manualScript: effectiveManualScript ?? undefined,
            storeAppDeploy,
          })
        : api.post<PreflightReport>("/api/preflight", {
            tenantId,
            vulnId,
            deviceId: primaryDeviceId,
            channel,
            source,
            sourceExplicit,
            packageId: overridePackageId ?? undefined,
            action,
            manualScript: effectiveManualScript ?? undefined,
            storeAppDeploy,
          }),
  });

  const remediate = useMutation<BatchOutcome[], Error>({
    mutationFn: async () => {
      // One batchId shared by every device in a multi-device dispatch, so the
      // Jobs page can group them under a single expandable row. Omitted for a
      // single-device dispatch so that job renders exactly as it does today.
      const batchId = deviceIds.length > 1 ? crypto.randomUUID() : undefined;
      // Settle each device independently: a 422 gate-block on one machine must
      // not discard the jobs that queued successfully for the others.
      const settled = await Promise.allSettled(
        deviceIds.map((id) =>
          isInventoryMode
            ? api.post<RemediationResult>("/api/software-inventory/fix", {
                tenantId,
                softwareId,
                deviceId: id,
                channel,
                source,
                sourceExplicit,
                packageId: overridePackageId ?? undefined,
                action,
                manualScript: effectiveManualScript ?? undefined,
                scheduleAt:
                  whenMode === "once" && scheduleAt ? scheduleAt.toISOString() : undefined,
                batchId,
                win32Deploy,
                storeAppDeploy,
              })
            : api.post<RemediationResult>("/api/remediations", {
                tenantId,
                vulnId,
                deviceId: id,
                channel,
                source,
                sourceExplicit,
                packageId: overridePackageId ?? undefined,
                action,
                manualScript: effectiveManualScript ?? undefined,
                scheduleAt:
                  whenMode === "once" && scheduleAt ? scheduleAt.toISOString() : undefined,
                batchId,
                win32Deploy,
                storeAppDeploy,
              }),
        ),
      );
      return settled.map((r, i) => {
        const id = deviceIds[i]!;
        const hostname = devices.find((d) => d.id === id)?.hostname ?? id;
        if (r.status === "fulfilled") {
          return { deviceId: id, hostname, ok: true as const, result: r.value };
        }
        const err = r.reason;
        const error =
          err instanceof ApiError
            ? err.status === 422
              ? failingCheckDetail(err.data) ?? "Blocked by the pre-flight gate."
              : err.message
            : err instanceof Error
              ? err.message
              : "Dispatch failed.";
        return { deviceId: id, hostname, ok: false as const, error };
      });
    },
  });

  // Manual option, "record" sub-mode: mark as manually remediated with no
  // script, no channel, no Job row — settled per-device like `remediate`.
  const markManual = useMutation<ManualRecordOutcome[], Error>({
    mutationFn: async () => {
      const settled = await Promise.allSettled(
        deviceIds.map((id) =>
          api.post<ManualRemediation>("/api/manual-remediations", {
            tenantId,
            deviceId: id,
            software,
            notes: manualNotes.trim(),
          }),
        ),
      );
      return settled.map((r, i) => {
        const id = deviceIds[i]!;
        const hostname = devices.find((d) => d.id === id)?.hostname ?? id;
        if (r.status === "fulfilled") {
          return { deviceId: id, hostname, ok: true as const, record: r.value };
        }
        const err = r.reason;
        const error = err instanceof Error ? err.message : "Failed to record.";
        return { deviceId: id, hostname, ok: false as const, error };
      });
    },
  });

  // Automated: creates a recurring `schedules` row directly — no dispatch, no
  // preflight, no per-device Job. `engineer` is derived server-side from the
  // session, same contract as Schedules.tsx's own create form.
  const createScheduleMutation = useMutation<Schedule, Error>({
    mutationFn: () =>
      api.post<Schedule>("/api/schedules", {
        tenantId,
        name: scheduleName.trim() || `Recurring patch — ${software}`,
        cron: toCron(recurrence),
        channel,
        target: {
          patchType,
          severity: scheduleSeverity,
          // Locks this schedule to exactly the software this dialog was
          // opened for — see ScheduleTarget.software. RunNowModal always
          // starts from one specific finding or inventory row, so a recurring
          // schedule created here must never widen to "every app patch."
          software,
          deviceGroupId: scheduleDeviceGroupId || undefined,
          excludedManagedDeviceIds: scheduleExcludedDeviceIds.length
            ? scheduleExcludedDeviceIds
            : undefined,
          // The "4. Catalog" pick above, carried onto the schedule so a
          // recurring fire dispatches the same package/script the engineer
          // reviewed here instead of always re-resolving the live auto-match.
          // Only meaningful for app findings — OS schedules have no catalog
          // step (see the "Not applicable" branch above).
          source: patchType === "app" ? source : undefined,
          packageId: patchType === "app" ? overridePackageId ?? undefined : undefined,
          scriptCatalogId:
            patchType === "app" && catalog === "script" ? scriptPick?.id : undefined,
        },
      }),
  });

  // Default to the first device once they load (mirrors the prototype, which
  // pre-selects the most-exposed device so the gate can run immediately).
  useEffect(() => {
    if (open && deviceIds.length === 0 && devices.length > 0)
      setDeviceIds([devices[0]!.id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, devices]);

  // Reset everything when the dialog is re-opened for a different finding.
  useEffect(() => {
    if (!open) return;
    setDeviceIds([]);
    setWhenMode("now");
    setScheduleAt(null);
    setRecurrence(defaultRecurrence());
    setScheduleName("");
    setScheduleSeverity("low");
    setScheduleDeviceGroupId("");
    setScheduleExcludedDeviceIds([]);
    setChannelOverride(null);
    setRemediationOption("patch");
    setCatalog("winget");
    setManualMode("dispatch");
    setManualScriptText("");
    setManualNotes("");
    setWingetPick(null);
    // Seed the search boxes from the software title so, if no live auto-match
    // exists, the search results are still relevant the moment either picker
    // opens. The catalogMatch effect above locks in a real match on top of
    // this shortly after (once the /api/catalog/match round trip resolves).
    setWingetQuery(patchType === "app" ? software : "");
    setChocoPick(null);
    setChocoQuery(patchType === "app" ? software : "");
    setScriptPick(null);
    setWin32DeployOpts(defaultWin32DeployOptions({ name: software }));
    setStoreAppPick(null);
    setStoreAppQuery(patchType === "app" ? software : "");
    setStoreAppDeployOpts(defaultStoreAppDeployOptions({ name: software }));
    setCopied(false);
    preflight.reset();
    remediate.reset();
    markManual.reset();
    createScheduleMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  // Uninstall has no source-driven path (Chocolatey/curated Store) — only
  // winget and an engineer-supplied Script both support it — so switching to
  // Uninstall drops back to the Winget catalog if Chocolatey/Store was
  // selected. Microsoft Store app (new) is exempted when Channel is Live
  // Response: there, the Store pick just resolves a winget package id (same
  // as WingetPicker), and Live Response's generated script already supports
  // an uninstall verb — the missing-uninstall-path restriction only applies
  // to the winget-app channel's create-or-reuse deploy flow.
  useEffect(() => {
    if (
      remediationOption === "uninstall" &&
      (catalog === "chocolatey" ||
        catalog === "microsoft-store" ||
        (catalog === "microsoft-store-app" && channel !== "live-response"))
    ) {
      setCatalog("winget");
    }
  }, [remediationOption, catalog, channel]);

  // The winget-app channel only supports create+assign (install intent) —
  // there's no uninstall verb story for a Store-sourced winGetApp, unlike
  // win32-app's Win32 wrapper uninstall path. Drop the channel override back
  // to auto-route if the engineer switches to Uninstall while it's selected.
  useEffect(() => {
    if (remediationOption === "uninstall" && channelOverride === "winget-app") {
      setChannelOverride(null);
    }
  }, [remediationOption, channelOverride]);

  // Catalog = Script force-locks the Channel to Intune (Platform/Remediation
  // Script); releases the lock back to auto-route when the engineer picks a
  // different catalog (or moves to Manual, which has no catalog at all). An
  // engineer who explicitly picks Intune (Win32 app) instead — to dispatch
  // the script through a Win32 wrapper — is exempted from the lock so that
  // choice sticks.
  useEffect(() => {
    if (methodLocked && channelOverride !== "win32-app") {
      setChannelOverride("intune-remediation");
    } else if (!methodLocked && channelOverride === "intune-remediation") {
      setChannelOverride(null);
    }
  }, [methodLocked, channelOverride]);

  // Inverse of the Script → Channel lock above: Channel = "Microsoft Store
  // app (new)" force-locks Catalog to the live Store search picker (that
  // channel has no other package source — it only creates/reuses a Store
  // app). Live Response is the one other channel allowed to carry this
  // catalog pick — there the Store search just resolves a package id that
  // gets dispatched via winget, same contract as a WingetPicker override —
  // so it's exempted from the auto-release-to-Winget below.
  useEffect(() => {
    if (channel === "winget-app" && catalog !== "microsoft-store-app") {
      setCatalog("microsoft-store-app");
    } else if (
      channel !== "winget-app" &&
      channel !== "live-response" &&
      catalog === "microsoft-store-app"
    ) {
      setCatalog("winget");
    }
  }, [channel, catalog]);

  // Re-run the pre-flight whenever any dispatch-relevant choice changes so the
  // gate result stays in lockstep with the Dispatch button's enabled state.
  // Manual "record" has no channel/script to preview — skip it entirely.
  useEffect(() => {
    if (!open) return;
    remediate.reset();
    if (isAutomated) {
      preflight.reset();
      return;
    }
    if (remediationOption === "manual" && manualMode === "record") {
      preflight.reset();
      return;
    }
    if (targetKey && primaryDeviceId && channel) {
      preflight.mutate();
    } else {
      preflight.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    targetKey,
    deviceKey,
    channel,
    source,
    overridePackageId,
    // winget-app has no overridePackageId (that field only covers
    // winget/chocolatey catalog picks) — without this, picking a Store
    // search result never re-triggers the preflight refetch, and the
    // preview panel is stuck showing whatever it last rendered (or nothing).
    storeAppPick?.packageId ?? null,
    action,
    effectiveManualScript,
    remediationOption,
    manualMode,
    isAutomated,
  ]);

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(
        previewBody(channel, {
          software,
          patchType,
          packageId: overridePackageId,
          installScope: report?.installScope,
          action,
          source,
        }),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions) — the body is still visible to select.
    }
  }

  const report = preflight.data;
  const result = remediate.data;
  const spec = CHANNEL_SPECS[channel];
  const isManualRecord = remediationOption === "manual" && manualMode === "record";
  // Neither the winget-app channel nor the Microsoft Store app (new) catalog
  // has a CVE-stored default packageId to fall back to (unlike
  // win32Deploy's win32DeployPackageId / WingetPicker's auto-match) — a live
  // Store search pick is mandatory before dispatch either way.
  const needsStoreAppPick =
    remediationOption !== "manual" &&
    (channel === "winget-app" || catalog === "microsoft-store-app");
  const canRun =
    !!report?.canProceed &&
    !tenantReadOnly &&
    canWrite &&
    deviceIds.length > 0 &&
    !remediate.isPending &&
    !result &&
    !isManualRecord &&
    (!needsManualScript || !!effectiveManualScript) &&
    (!needsStoreAppPick || !!storeAppPick) &&
    (whenMode !== "once" || (!!scheduleAt && scheduleAt.getTime() > Date.now()));
  const canCreateSchedule =
    isAutomated &&
    !tenantReadOnly &&
    canWrite &&
    !createScheduleMutation.isPending &&
    !createScheduleMutation.data &&
    (recurrence.freq !== "weekly" || recurrence.daysOfWeek.length > 0);
  const canMarkManual =
    isManualRecord &&
    deviceIds.length > 0 &&
    !!manualNotes.trim() &&
    !markManual.isPending &&
    !markManual.data &&
    !tenantReadOnly &&
    canWrite;

  return (
    <WizardShell
      open={open}
      onClose={onClose}
      title="Remediation options"
      subtitle={displayName ?? software}
    >
      <div className="space-y-5">
        {!isAutomated && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-xs font-medium text-slate-600">
              Affected devices
              {deviceIds.length > 0 && (
                <span className="ml-1 font-normal text-slate-400">
                  ({deviceIds.length} selected)
                </span>
              )}
            </label>
            {devices.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setDeviceIds(
                    deviceIds.length === devices.length
                      ? []
                      : devices.map((d) => d.id),
                  )
                }
                className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
              >
                {deviceIds.length === devices.length
                  ? "Clear all"
                  : "Select all"}
              </button>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-300 bg-white">
            {exposedLoading || inventoryDevicesLoading ? (
              <div className="px-3 py-2.5 text-xs text-slate-400">
                Loading affected devices…
              </div>
            ) : devices.length === 0 ? (
              <div className="px-3 py-2.5 text-xs text-slate-400">
                {isInventoryMode
                  ? "No devices currently have this software installed."
                  : "No devices are currently exposed to this finding."}
              </div>
            ) : (
              devices.map((d) => {
                const checked = deviceIds.includes(d.id);
                return (
                  <label
                    key={d.id}
                    className="flex cursor-pointer items-center gap-2.5 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDevice(d.id)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                      {d.hostname}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {d.os}
                    </span>
                  </label>
                );
              })
            )}
          </div>
          {deviceIds.length > 1 && (
            <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
              The gate is previewed on{" "}
              <span className="font-medium">{device?.hostname}</span>; the run
              dispatches one remediation per selected device.
            </p>
          )}
        </div>
        )}

        {/* ── 1. When ──────────────────────────────────────────────────── */}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            1. When
          </label>
          <div className="grid grid-cols-3 gap-2">
            {WHEN_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setWhenMode(m.id);
                  setChannelOverride(null);
                }}
                className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                  whenMode === m.id
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="text-xs font-medium">{m.label}</div>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-tight text-slate-500">
            {isAutomated ? (
              <>
                Creates a recurring schedule scoped to{" "}
                <span className="font-medium">{displayName ?? software}</span>{" "}
                only, on the devices selected below.
              </>
            ) : (
              <>
                Auto-routes to{" "}
                <span className="font-medium">{CHANNEL_SPECS[autoChannel].label}</span>.
                Override below if needed.
              </>
            )}
          </p>

          {whenMode === "once" && (
            <div className="mt-2">
              <DateTimePicker value={scheduleAt} onChange={setScheduleAt} />
            </div>
          )}

          {isAutomated && (
            <div className="mt-2 space-y-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-600">
                  Schedule name
                </label>
                <input
                  type="text"
                  value={scheduleName}
                  onChange={(e) => setScheduleName(e.target.value)}
                  placeholder={`Recurring patch — ${software}`}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-600">
                  Devices
                </label>
                <select
                  value={scheduleDeviceGroupId}
                  onChange={(e) => {
                    setScheduleDeviceGroupId(e.target.value);
                    setScheduleExcludedDeviceIds([]);
                  }}
                  className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-800 focus:border-slate-500 focus:outline-none"
                >
                  <option value="">All devices</option>
                  {scheduleGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name} ({g.memberCount})
                    </option>
                  ))}
                </select>
              </div>

              {scheduleDeviceGroupId && scheduleGroupMembers.length > 0 && (
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-600">
                    Exclude from this schedule
                  </label>
                  <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-300 bg-white">
                    {scheduleGroupMembers.map((m) => {
                      const excluded = scheduleExcludedDeviceIds.includes(m.managedDeviceId);
                      return (
                        <label
                          key={m.id}
                          className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-xs text-slate-700 last:border-0 hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={(e) =>
                              setScheduleExcludedDeviceIds((current) =>
                                e.target.checked
                                  ? [...current, m.managedDeviceId]
                                  : current.filter((id) => id !== m.managedDeviceId),
                              )
                            }
                            className="h-3.5 w-3.5 rounded border-slate-300 text-slate-900 focus:ring-slate-400"
                          />
                          {m.deviceHostname}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1 block text-[11px] font-medium text-slate-600">
                  Minimum severity level
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {SEVERITY_FLOORS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setScheduleSeverity(s.id)}
                      className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
                        scheduleSeverity === s.id
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {scheduleSeverity === "none" && (
                  <p className="mt-1 text-[11px] leading-tight text-slate-500">
                    Matches every open finding regardless of severity, and also sweeps
                    outdated software that has no CVE at all.
                  </p>
                )}
              </div>
              <RecurrencePicker value={recurrence} onChange={setRecurrence} />
            </div>
          )}
        </div>

        {!isAutomated && (
        <div>
          {/* ── 2. Remediation Option ────────────────────────────────────── */}
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            2. Remediation Option
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: "patch", label: "Patch/Update" },
                { id: "uninstall", label: "Uninstall" },
                { id: "manual", label: "Manual" },
              ] as const
            ).map((opt) => {
              const disabled = patchType === "os" && opt.id !== "patch";
              const active = remediationOption === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setRemediationOption(opt.id)}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                    active
                      ? "border-slate-900 bg-slate-900 text-white"
                      : disabled
                        ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="text-xs font-medium">{opt.label}</div>
                  {disabled && (
                    <div className="mt-0.5 text-[10px] leading-tight text-slate-400">
                      Not applicable to OS findings.
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        )}

        {/* ── 3. Channel ───────────────────────────────────────────────── */}
        {!isManualRecord && (
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              3. Channel
            </label>
            {methodLocked ? (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-slate-800">
                    {spec.label}
                    <PreviewBadge active={false} />
                  </div>
                  <div className="mt-0.5 text-[10px] leading-tight text-slate-400">
                    {channel === "win32-app" ? (
                      <>
                        Locked — Script Catalog dispatch via {spec.label} was
                        chosen before switching to this catalog.
                      </>
                    ) : (
                      <>
                        Locked — Script Catalog dispatch only runs through{" "}
                        {CHANNEL_SPECS["intune-remediation"].label}.
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  {TRIGGER_ORDER.map((c) => {
                    const s = CHANNEL_SPECS[c];
                    const applicable =
                      patchType === "os"
                        ? c === "expedited-quality-update"
                        : c === "winget-app" && remediationOption === "uninstall"
                          ? false
                          : s.supports[patchType];
                    const active = channel === c;
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={!applicable}
                        onClick={() => setChannelOverride(c === autoChannel ? null : c)}
                        className={`flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? "border-slate-900 bg-slate-900 text-white"
                            : applicable
                              ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                              : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs font-medium">
                            {s.label}
                            {s.availability === "preview" && (
                              <PreviewBadge active={active} />
                            )}
                          </div>
                          <div
                            className={`mt-0.5 text-[10px] leading-tight ${
                              active ? "text-slate-300" : "text-slate-400"
                            }`}
                          >
                            {TRIGGER_CAPTIONS[c] ?? s.useCase}
                            {!applicable &&
                              (patchType === "os"
                                ? " Not applicable to OS findings."
                                : " Not applicable to third-party apps.")}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {triggerOverridden && (
                  <p className="mt-1.5 text-[11px] leading-tight text-amber-600">
                    Overridden — Scheduling would have routed to{" "}
                    {CHANNEL_SPECS[autoChannel].label}.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Rendered for Automated too, gated the same way as the other modes:
            remediationOption stays "patch" throughout Automated (no UI here
            changes it), so the manual branch below never triggers — this
            always resolves to the OS "not applicable" panel or the app
            catalog picker, letting the engineer pin a Winget/Chocolatey/
            Script Catalog choice onto the recurring schedule instead of
            always leaving it to the live auto-match at fire time. */}
        <div>
          {/* ── 4. Catalog / Manual remediation ───────────────────────── */}
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            4. {remediationOption === "manual" ? "Manual remediation" : "Catalog"}
          </label>

          {remediationOption === "manual" ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setManualMode("dispatch")}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                    manualMode === "dispatch"
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="text-xs font-medium">Dispatch with a script</div>
                </button>
                <button
                  type="button"
                  onClick={() => setManualMode("record")}
                  className={`rounded-lg border px-2 py-2 text-left transition-colors ${
                    manualMode === "record"
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="text-xs font-medium">Record only</div>
                </button>
              </div>

              {manualMode === "dispatch" ? (
                <div className="space-y-1.5">
                  <textarea
                    value={manualScriptText}
                    onChange={(e) => setManualScriptText(e.target.value)}
                    rows={6}
                    placeholder={
                      "# Script to run on the device via the Channel above.\n# Runs exactly as written — no winget/catalog substitution."
                    }
                    className="w-full rounded-lg border border-slate-300 bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-slate-500 focus:outline-none"
                  />
                  <p className="text-[11px] leading-tight text-slate-500">
                    Dispatched through the Channel selected above exactly as
                    written.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <textarea
                    value={manualNotes}
                    onChange={(e) => setManualNotes(e.target.value)}
                    rows={4}
                    placeholder="What was done to remediate this manually? (steps taken, ticket reference, etc.)"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
                  />
                  {tenantReadOnly && (
                    <p className="text-[11px] text-amber-600">
                      This tenant is read-only.
                    </p>
                  )}
                  {!canWrite && (
                    <p className="text-[11px] text-amber-600">
                      Your role doesn't include remediation write access.
                    </p>
                  )}
                  {markManual.isError && (
                    <p className="text-[11px] text-rose-600">
                      {markManual.error.message}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => markManual.mutate()}
                    disabled={!canMarkManual}
                    className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                  >
                    {markManual.isPending
                      ? "Recording…"
                      : deviceIds.length > 1
                        ? `Mark ${deviceIds.length} devices as manually remediated`
                        : "Mark as manually remediated"}
                  </button>
                  <p className="text-[11px] leading-tight text-slate-500">
                    No script runs and no Job is created. PatchPilot confirms
                    automatically once Defender's next scan stops reporting
                    this CVE on the selected device
                    {deviceIds.length === 1 ? "" : "s"}.
                  </p>
                </div>
              )}
            </div>
          ) : patchType === "os" ? (
            <div className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 opacity-60">
              <div className="text-xs font-medium text-slate-400">
                Not applicable
              </div>
              <div className="mt-0.5 text-[10px] leading-tight text-slate-400">
                {spec.label} pushes the update directly — no catalog package
                or generated script is involved.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Channel = "Microsoft Store app (new)" force-locks Catalog to
                  the live Store search picker below (see the channel↔catalog
                  effect above) — grey out the other catalog tabs so the
                  engineer isn't offered choices that can't take effect. */}
              {/* Winget catalog (default) */}
              <button
                type="button"
                disabled={channel === "winget-app"}
                onClick={() => setCatalog("winget")}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  catalog === "winget"
                    ? "border-slate-900 bg-slate-900 text-white"
                    : channel === "winget-app"
                      ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="text-xs font-medium">Winget catalog</div>
                <div
                  className={`mt-0.5 text-[10px] leading-tight ${
                    catalog === "winget" ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {channel === "winget-app"
                    ? "Locked out — Channel is set to Microsoft Store app (new)."
                    : "Auto-matched from PatchPilot's mirrored winget library — search below to override."}
                </div>
              </button>
              {catalog === "winget" && (
                <WingetPicker
                  wingetPick={wingetPick}
                  setWingetPick={setWingetPick}
                  wingetQuery={wingetQuery}
                  setWingetQuery={setWingetQuery}
                  wingetResults={wingetResults}
                  wingetSearching={wingetSearching}
                  wingetSearch={wingetSearch}
                />
              )}

              {/* Chocolatey catalog — real via Live Response and Intune
                  (Win32 app) deploy; still simulated via On-demand Intune
                  Remediation, same as winget (see CHANNEL_SPECS[channel]
                  .availability, which the Preview badge below tracks). */}
              <button
                type="button"
                disabled={remediationOption === "uninstall" || channel === "winget-app"}
                onClick={() => setCatalog("chocolatey")}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  catalog === "chocolatey"
                    ? "border-slate-900 bg-slate-900 text-white"
                    : remediationOption === "uninstall" || channel === "winget-app"
                      ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  Chocolatey catalog
                  {CHANNEL_SPECS[channel].availability === "preview" && (
                    <PreviewBadge active={catalog === "chocolatey"} />
                  )}
                </div>
                <div
                  className={`mt-0.5 text-[10px] leading-tight ${
                    catalog === "chocolatey" ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {channel === "winget-app"
                    ? "Locked out — Channel is set to Microsoft Store app (new)."
                    : remediationOption === "uninstall"
                      ? "No uninstall path via Chocolatey yet — use Winget or a Manual script."
                      : "Auto-matched from the mirrored Chocolatey community repository — search below to override."}
                </div>
              </button>
              {catalog === "chocolatey" && (
                <ChocolateyPicker
                  chocoPick={chocoPick}
                  setChocoPick={setChocoPick}
                  chocoQuery={chocoQuery}
                  setChocoQuery={setChocoQuery}
                  chocoResults={chocoResults}
                  chocoSearching={chocoSearching}
                  chocoSearch={chocoSearch}
                />
              )}

              {/* Script Catalog (preview, Intune-only) */}
              <button
                type="button"
                disabled={channel === "winget-app"}
                onClick={() => setCatalog("script")}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  catalog === "script"
                    ? "border-slate-900 bg-slate-900 text-white"
                    : channel === "winget-app"
                      ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  Script Catalog
                  <PreviewBadge active={catalog === "script"} />
                </div>
                <div
                  className={`mt-0.5 text-[10px] leading-tight ${
                    catalog === "script" ? "text-slate-300" : "text-slate-400"
                  }`}
                >
                  {channel === "winget-app"
                    ? "Locked out — Channel is set to Microsoft Store app (new)."
                    : channelOverride === "win32-app"
                      ? "Dispatch an engineer-uploaded script via Intune (Win32 app)."
                      : "Dispatch an engineer-uploaded script. Locks Channel to Intune (Platform/Remediation Script)."}
                </div>
              </button>
              {catalog === "script" && (
                <ScriptPicker
                  scripts={scripts}
                  scriptPick={scriptPick}
                  setScriptPick={setScriptPick}
                  loading={scriptsLoading}
                  channel={channel}
                />
              )}

              {/* Microsoft Store — only when curated for this app */}
              {storeAlt && (
                <button
                  type="button"
                  disabled={remediationOption === "uninstall" || channel === "winget-app"}
                  onClick={() => setCatalog("microsoft-store")}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    catalog === "microsoft-store"
                      ? "border-slate-900 bg-slate-900 text-white"
                      : remediationOption === "uninstall" || channel === "winget-app"
                        ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-medium">
                    {SOURCE_LABELS["microsoft-store"]}
                    <PreviewBadge active={catalog === "microsoft-store"} />
                  </div>
                  <div
                    className={`mt-0.5 break-all text-[10px] leading-tight ${
                      catalog === "microsoft-store"
                        ? "text-slate-300"
                        : "text-slate-400"
                    }`}
                  >
                    {channel === "winget-app"
                      ? "Locked out — Channel is set to Microsoft Store app (new)."
                      : remediationOption === "uninstall"
                        ? "No uninstall path via Microsoft Store yet — use Winget or a Manual script."
                        : `Curated Store product: ${storeAlt.packageId}`}
                  </div>
                </button>
              )}

              {/* Microsoft Store app (new) — a genuinely different catalog
                  from the curated "Microsoft Store" tab above: a live
                  manifestSearch lookup. Two channels can drive it: "winget-app"
                  (create/reuse a genuine Intune Store app — no other package
                  source applies there, so picking this catalog from any other
                  channel routes to it) and Live Response (the resolved
                  package id just feeds winget's upgrade/uninstall verbs, same
                  as a WingetPicker override — picking this catalog while
                  already on Live Response leaves the channel alone). */}
              <button
                type="button"
                disabled={remediationOption === "uninstall" && channel !== "live-response"}
                onClick={() => {
                  if (channel !== "live-response") setChannelOverride("winget-app");
                  setCatalog("microsoft-store-app");
                }}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  catalog === "microsoft-store-app"
                    ? "border-slate-900 bg-slate-900 text-white"
                    : remediationOption === "uninstall" && channel !== "live-response"
                      ? "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 opacity-60"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="text-xs font-medium">
                  Microsoft Store app (new)
                </div>
                <div
                  className={`mt-0.5 text-[10px] leading-tight ${
                    catalog === "microsoft-store-app"
                      ? "text-slate-300"
                      : "text-slate-400"
                  }`}
                >
                  {remediationOption === "uninstall" && channel !== "live-response"
                    ? "No uninstall path via Microsoft Store app (new) here — switch Channel to Live Response, or use Winget/a Manual script."
                    : channel === "live-response"
                      ? "Live Microsoft Store lookup — resolves a package id and runs winget through Live Response."
                      : "Live Microsoft Store lookup, deployed as a genuine Intune app. Locks Channel to Microsoft Store app (new)."}
                </div>
              </button>
              {catalog === "microsoft-store-app" && (
                <>
                  <MicrosoftStorePicker
                    pick={storeAppPick}
                    setPick={setStoreAppPick}
                    query={storeAppQuery}
                    setQuery={setStoreAppQuery}
                  />
                  {channel === "live-response" && (
                    <p className="text-[11px] leading-tight text-slate-500">
                      Dispatched via winget through Live Response — no Intune
                      app is created. Deploy options below only apply to the
                      Microsoft Store app (new) channel.
                    </p>
                  )}
                </>
              )}

              {channel === "win32-app" &&
                catalog !== "microsoft-store" &&
                catalog !== "microsoft-store-app" && (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      Win32 app deploy options
                    </div>
                    <Win32DeployOptionsPanel
                      value={win32DeployOpts}
                      onChange={setWin32DeployOpts}
                      source={catalog}
                      tenantId={tenantId}
                    />
                  </div>
                )}

              {channel === "winget-app" && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3">
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Microsoft Store app deploy options
                  </div>
                  <StoreAppDeployOptionsPanel
                    value={storeAppDeployOpts}
                    onChange={setStoreAppDeployOpts}
                    tenantId={tenantId}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 5. Preview & checks ──────────────────────────────────────── */}
        {!(isManualRecord && !markManual.data) && (
          <div className="border-t border-slate-200 pt-4">
            <label className="mb-3 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Preview & checks
            </label>
            <div className="space-y-5">
              {isAutomated ? (
                createScheduleMutation.data ? (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                      Created — this will run as a recurring{" "}
                      {scheduleDeviceGroupId
                        ? `"${scheduleGroups.find((g) => g.id === scheduleDeviceGroupId)?.name ?? "group"}"`
                        : "tenant-wide"}{" "}
                      sweep matching {patchType === "os" ? "OS" : "app"} patches
                      {scheduleSeverity === "none"
                        ? ", including software with no CVE finding"
                        : ` at ${SEVERITY_FLOORS.find((s) => s.id === scheduleSeverity)?.label.toLowerCase()}`}
                      .
                    </div>
                    <Link
                      to="/schedules"
                      onClick={onClose}
                      className="block w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    >
                      View schedules
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {createScheduleMutation.isError && (
                      <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                        {createScheduleMutation.error.message}
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
                        onClick={() => createScheduleMutation.mutate()}
                        disabled={!canCreateSchedule}
                        className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                      >
                        {createScheduleMutation.isPending ? "Creating…" : "Create schedule"}
                      </button>
                    </div>
                  </div>
                )
              ) : isManualRecord ? (
                (() => {
                  const outcomes = markManual.data!;
                  const ok = outcomes.filter((o) => o.ok);
                  const failed = outcomes.filter((o) => !o.ok);
                  return (
                    <div className="space-y-3">
                      <div
                        className={`rounded-lg border px-3 py-2 text-xs ${
                          failed.length === 0
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : ok.length === 0
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : "border-amber-200 bg-amber-50 text-amber-700"
                        }`}
                      >
                        {ok.length > 0 ? (
                          <>
                            Recorded on {ok.length} device{ok.length === 1 ? "" : "s"}
                            {failed.length > 0 ? `, ${failed.length} failed` : ""}.
                            PatchPilot will confirm automatically once
                            Defender's next scan stops reporting this CVE on
                            each device.
                          </>
                        ) : (
                          <>Nothing was recorded — every device failed.</>
                        )}
                      </div>
                      <ul className="rounded-lg border border-slate-200">
                        {outcomes.map((o) => (
                          <li
                            key={o.deviceId}
                            className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-0"
                          >
                            <div className="min-w-0">
                              <div className="truncate text-xs font-medium text-slate-800">
                                {o.hostname}
                              </div>
                              {!o.ok && (
                                <div className="text-[11px] text-rose-600">{o.error}</div>
                              )}
                            </div>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                o.ok
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-rose-100 text-rose-700"
                              }`}
                            >
                              {o.ok ? "Waiting on Defender" : "Failed"}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        onClick={onClose}
                        className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                      >
                        Close
                      </button>
                    </div>
                  );
                })()
              ) : (
                <>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-800">
                        {spec.label}
                      </span>
                      <span className="text-xs text-slate-500">{spec.latency}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">{spec.useCase}</div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        Graph call preview
                      </span>
                      <button
                        type="button"
                        onClick={copyBody}
                        className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
                      >
                        {copied ? "Copied!" : "Copy body"}
                      </button>
                    </div>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100">
                      {previewEndpoint(channel, device)}
                    </pre>
                    <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-900 px-3 py-2 text-[11px] leading-relaxed text-slate-100">
                      {previewBody(channel, {
                        software,
                        patchType,
                        packageId: overridePackageId,
                        installScope: report?.installScope,
                        action,
                        source,
                      })}
                    </pre>
                  </div>

                  {deviceIds.length > 1 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Group execution: dispatches concurrently to all {deviceIds.length}{" "}
                      selected devices. Each device produces its own Job record.
                    </div>
                  )}

                  {tenantReadOnly && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      This tenant is read-only. Opt in to write actions under Settings →
                      Tenants before remediating.
                    </div>
                  )}

                  {!canWrite && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Your role doesn't include remediation write access — ask an admin
                      to change it under Settings → Users.
                    </div>
                  )}

                  {needsManualScript && !effectiveManualScript && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      {remediationOption === "manual"
                        ? "Enter a script above before dispatching."
                        : "Pick a script from the Script Catalog above before dispatching."}
                    </div>
                  )}

                  {needsStoreAppPick && !storeAppPick && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      Search and pick a Microsoft Store package above before dispatching.
                    </div>
                  )}

                  {preflight.isError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      {preflight.error.message}
                    </div>
                  )}
                  {remediate.isError && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                      {remediate.error instanceof ApiError && remediate.error.status === 422
                        ? "Remediation was blocked by the pre-flight gate — resolve the failing checks below."
                        : remediate.error.message}
                    </div>
                  )}

                  {report && !result && (
                    <div>
                      <div
                        className={`rounded-lg border px-3 py-2 text-xs font-medium ${
                          report.canProceed
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-rose-200 bg-rose-50 text-rose-700"
                        }`}
                      >
                        {report.canProceed
                          ? "Cleared — this remediation can proceed."
                          : "Blocked — at least one check failed."}
                      </div>
                      <ul className="mt-2 rounded-lg border border-slate-200">
                        {report.checks.map((c) => (
                          <li
                            key={c.id}
                            className="flex items-start justify-between gap-3 border-b border-slate-100 px-3 py-2.5 last:border-0"
                          >
                            <div>
                              <div className="text-xs font-medium text-slate-800">
                                {c.label}
                              </div>
                              <div className="mt-0.5 text-[11px] text-slate-500">
                                {c.detail}
                              </div>
                            </div>
                            <StatusChip status={c.status} />
                          </li>
                        ))}
                      </ul>

                      {/* The exact code this run will execute on the device, shown BEFORE
                          dispatch so the engineer reviews it up front — not only after. */}
                      {report.script && (
                        <div className="mt-3">
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                            Generated script —{" "}
                            {deviceIds.length > 1
                              ? `runs on each of the ${deviceIds.length} selected devices`
                              : `runs on ${device?.hostname ?? "the device"}`}
                          </div>
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                            {report.script}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}

                  {result ? (
                    (() => {
                      const queued = result.filter((o) => o.ok);
                      const failed = result.filter((o) => !o.ok);
                      // The generated script is identical across devices, so show it once
                      // from any queued device's payload.
                      const queuedScript = queued.find((o) => o.ok)?.result.script;
                      return (
                        <div className="space-y-3">
                          <div
                            className={`rounded-lg border px-4 py-3 ${
                              failed.length === 0
                                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                : queued.length === 0
                                  ? "border-rose-200 bg-rose-50 text-rose-800"
                                  : "border-amber-200 bg-amber-50 text-amber-800"
                            }`}
                          >
                            {queued.length > 0 ? (
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-sm font-medium">
                                  Queued {queued.length} remediation
                                  {queued.length === 1 ? "" : "s"}
                                  {failed.length > 0 ? `, ${failed.length} blocked` : ""}.
                                </p>
                                <Link
                                  to="/jobs"
                                  onClick={onClose}
                                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors ${
                                    failed.length === 0
                                      ? "bg-emerald-600 hover:bg-emerald-700"
                                      : "bg-amber-600 hover:bg-amber-700"
                                  }`}
                                >
                                  Track on Jobs page →
                                </Link>
                              </div>
                            ) : (
                              <p className="text-sm font-medium">
                                No remediations were queued — every device was blocked.
                              </p>
                            )}
                          </div>

                          <ul className="rounded-lg border border-slate-200">
                            {result.map((o) => (
                              <li
                                key={o.deviceId}
                                className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-0"
                              >
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-medium text-slate-800">
                                    {o.hostname}
                                  </div>
                                  {o.ok ? (
                                    <div className="text-[11px] text-slate-500">
                                      Job {o.result.job.id.slice(0, 8)}…
                                    </div>
                                  ) : (
                                    <div className="text-[11px] text-rose-600">
                                      {o.error}
                                    </div>
                                  )}
                                </div>
                                <span
                                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                    o.ok
                                      ? "bg-emerald-100 text-emerald-700"
                                      : "bg-rose-100 text-rose-700"
                                  }`}
                                >
                                  {o.ok ? "Queued" : "Blocked"}
                                </span>
                              </li>
                            ))}
                          </ul>

                          {queuedScript && (
                            <div>
                              <button
                                type="button"
                                onClick={() => setShowQueuedScript((v) => !v)}
                                className="text-xs font-medium text-slate-500 hover:text-slate-800"
                              >
                                {showQueuedScript ? "Hide" : "Show"} deployable script
                                (remediation payload)
                              </button>
                              {showQueuedScript && (
                                <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
                                  {queuedScript}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()
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
                        onClick={() => remediate.mutate()}
                        disabled={!canRun}
                        className="flex-1 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                      >
                        {remediate.isPending
                          ? whenMode === "once"
                            ? "Scheduling…"
                            : "Dispatching…"
                          : whenMode === "once"
                            ? deviceIds.length > 1
                              ? `Schedule for ${deviceIds.length} devices`
                              : "Schedule dispatch"
                            : deviceIds.length > 1
                              ? `Dispatch to ${deviceIds.length} devices`
                              : "Dispatch now"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </WizardShell>
  );
}
