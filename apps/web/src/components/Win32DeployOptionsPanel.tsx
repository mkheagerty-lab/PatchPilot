import { type IntuneAssignmentMode } from "../lib/api";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

/** Which wrapper family the app is packaged/installed through. */
export type Win32PanelSource = "winget" | "chocolatey" | "script";

export interface Win32DeployOptionsValue {
  displayName: string;
  description: string;
  publisher: string;
  runAsAccount: "system" | "user";
  // Chocolatey-specific install options — ignored server-side for other sources.
  installChoco: boolean;
  customRepo: string;
  customArguments: string;
  assignmentMode: IntuneAssignmentMode;
  groupId: string;
  groupName: string;
  excludeGroupId: string;
  excludeGroupName: string;
}

export function defaultWin32DeployOptions(seed?: {
  name?: string;
  publisher?: string;
  packageId?: string;
}): Win32DeployOptionsValue {
  return {
    displayName: seed?.name ?? "",
    description: seed?.packageId ? `Deployed via PatchPilot — ${seed.packageId}` : "",
    publisher: seed?.publisher ?? "",
    runAsAccount: "system",
    installChoco: true,
    customRepo: "",
    customArguments: "",
    assignmentMode: "none",
    groupId: "",
    groupName: "",
    excludeGroupId: "",
    excludeGroupName: "",
  };
}

const ASSIGNMENT_OPTIONS: { id: IntuneAssignmentMode; label: string }[] = [
  { id: "none", label: "Do not Assign" },
  { id: "all-devices", label: "All Devices" },
  { id: "all-users", label: "All Users" },
  { id: "group", label: "Custom Group" },
];

/**
 * Intune rejects Win32 apps that install "As User" but are assigned to a
 * device-scoped target (All Devices / a device group) — there's no user
 * context to install into, and it surfaces as a failed "Install Scope"
 * applicability check ("Blocked — at least one check failed") in the admin
 * center. Device-scoped modes are hidden from the Assignment dropdown
 * whenever Install As is "user" so that misconfiguration can't be made here.
 */
const USER_ASSIGNMENT_MODES: IntuneAssignmentMode[] = ["none", "all-users", "group"];

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none";

/**
 * Controlled fields for configuring an inline Win32 app deploy-or-reuse —
 * extracted from the old standalone `DeployAppModal` so Run Now / Fix All can
 * embed the same options without a modal of their own. No mutation/submit
 * logic here: the parent owns the value, the dispatch call, and validation.
 *
 * `showNameFields` is off for Fix All, where Name/Description/Publisher are
 * resolved per-row server-side from the catalog rather than typed once for a
 * batch of different packages.
 */
export function Win32DeployOptionsPanel({
  value,
  onChange,
  source,
  tenantId,
  disabled,
  showNameFields = true,
  lockCreationFields,
}: {
  value: Win32DeployOptionsValue;
  onChange: (value: Win32DeployOptionsValue) => void;
  source: Win32PanelSource;
  tenantId: string | null;
  disabled?: boolean;
  showNameFields?: boolean;
  /**
   * Publisher/Install As/Chocolatey options/Custom arguments can't be changed
   * after the app is created — only DeployAppModal's edit-after-create flow
   * (its `update` mutation only ever PATCHes displayName/description/
   * assignment) needs this; Run Now / Fix All dispatch once and never hit it.
   */
  lockCreationFields?: boolean;
}) {
  const set = <K extends keyof Win32DeployOptionsValue>(key: K, v: Win32DeployOptionsValue[K]) =>
    onChange({ ...value, [key]: v });
  const creationDisabled = disabled || lockCreationFields;

  const groupNeeded = value.assignmentMode === "group";
  const assignmentOptions =
    value.runAsAccount === "user"
      ? ASSIGNMENT_OPTIONS.filter((o) => USER_ASSIGNMENT_MODES.includes(o.id))
      : ASSIGNMENT_OPTIONS;

  return (
    <div className="space-y-4">
      {showNameFields && (
        <>
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Application Name
            </label>
            <input
              className={INPUT_CLASS}
              value={value.displayName}
              onChange={(e) => set("displayName", e.target.value)}
              disabled={disabled}
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Description
            </label>
            <textarea
              className={`${INPUT_CLASS} min-h-[72px] resize-y`}
              value={value.description}
              onChange={(e) => set("description", e.target.value)}
              disabled={disabled}
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Publisher
            </label>
            <input
              className={INPUT_CLASS}
              value={value.publisher}
              onChange={(e) => set("publisher", e.target.value)}
              disabled={creationDisabled}
              title={lockCreationFields ? "Publisher can't be changed after creation." : undefined}
            />
          </div>
        </>
      )}

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Install As
        </label>
        <select
          className={INPUT_CLASS}
          value={value.runAsAccount}
          onChange={(e) => {
            const runAsAccount = e.target.value === "user" ? "user" : "system";
            const assignmentMode =
              runAsAccount === "user" && !USER_ASSIGNMENT_MODES.includes(value.assignmentMode)
                ? "none"
                : value.assignmentMode;
            onChange({ ...value, runAsAccount, assignmentMode });
          }}
          disabled={creationDisabled}
          title={lockCreationFields ? "Install behaviour can't be changed after creation." : undefined}
        >
          <option value="system">System</option>
          <option value="user">User</option>
        </select>
      </div>

      {source === "chocolatey" && (
        <div>
          <label className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <input
              type="checkbox"
              checked={value.installChoco}
              onChange={(e) => set("installChoco", e.target.checked)}
              disabled={creationDisabled}
            />
            Install Chocolatey if missing
          </label>
          <input
            className={`${INPUT_CLASS} mt-2`}
            value={value.customRepo}
            onChange={(e) => set("customRepo", e.target.value)}
            placeholder="Custom Chocolatey source URL (optional)"
            disabled={creationDisabled}
          />
        </div>
      )}

      {source !== "script" && (
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Custom install arguments (optional)
          </label>
          <input
            className={INPUT_CLASS}
            value={value.customArguments}
            onChange={(e) => set("customArguments", e.target.value)}
            placeholder={source === "winget" ? '--override "/S"' : "/NoDesktopShortcut"}
            disabled={creationDisabled}
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Assignment
        </label>
        <select
          className={INPUT_CLASS}
          value={value.assignmentMode}
          onChange={(e) => set("assignmentMode", e.target.value as IntuneAssignmentMode)}
          disabled={disabled}
        >
          {assignmentOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>

        {groupNeeded && (
          <div className="mt-2">
            <EntraGroupPicker
              tenantId={tenantId}
              value={value.groupId ? { id: value.groupId, displayName: value.groupName } : null}
              onChange={(pick: EntraGroupPick | null) =>
                onChange({ ...value, groupId: pick?.id ?? "", groupName: pick?.displayName ?? "" })
              }
              disabled={disabled}
              placeholder="Search Entra groups to include…"
            />
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
              Requires the Group.Read.All scope. Tenants onboarded before this feature shipped need
              re-consent before group assignment works here.
            </div>
            {value.runAsAccount === "user" && (
              <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700">
                Install As: User assignments must target a group whose members are users, not devices
                — a device-only group will fail Intune's "Install Scope" applicability check.
              </div>
            )}
          </div>
        )}

        {value.assignmentMode !== "none" && (
          <div className="mt-3">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Excluded Group (optional)
            </label>
            <EntraGroupPicker
              tenantId={tenantId}
              value={
                value.excludeGroupId
                  ? { id: value.excludeGroupId, displayName: value.excludeGroupName }
                  : null
              }
              onChange={(pick: EntraGroupPick | null) =>
                onChange({
                  ...value,
                  excludeGroupId: pick?.id ?? "",
                  excludeGroupName: pick?.displayName ?? "",
                })
              }
              disabled={disabled}
              placeholder="Search Entra groups to exclude…"
            />
          </div>
        )}
      </div>
    </div>
  );
}
