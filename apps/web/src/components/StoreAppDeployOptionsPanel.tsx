import { type IntuneAssignmentMode } from "../lib/api";
import { EntraGroupPicker, type EntraGroupPick } from "./EntraGroupPicker";

export interface StoreAppDeployOptionsValue {
  displayName: string;
  description: string;
  publisher: string;
  runAsAccount: "system" | "user";
  assignmentMode: IntuneAssignmentMode;
  groupId: string;
  groupName: string;
  excludeGroupId: string;
  excludeGroupName: string;
}

export function defaultStoreAppDeployOptions(seed?: {
  name?: string;
  publisher?: string;
  packageId?: string;
}): StoreAppDeployOptionsValue {
  return {
    displayName: seed?.name ?? "",
    description: seed?.packageId ? `Deployed via PatchPilot — ${seed.packageId}` : "",
    publisher: seed?.publisher ?? "",
    runAsAccount: "system",
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

/** Mirrors Win32DeployOptionsPanel's device-vs-user assignment gating. */
const USER_ASSIGNMENT_MODES: IntuneAssignmentMode[] = ["none", "all-users", "group"];

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none";

/**
 * Controlled fields for configuring an inline Microsoft Store app (winGetApp)
 * deploy-or-reuse — mirrors Win32DeployOptionsPanel but trimmed to the
 * required-fields-only scope decided for this channel: Name, Description,
 * Publisher, Install As, Assignment. No Chocolatey install options and no
 * custom install arguments field — winGetApp has no wrapper script to pass
 * them through, unlike the Win32 wrapper pipeline.
 */
export function StoreAppDeployOptionsPanel({
  value,
  onChange,
  tenantId,
  disabled,
}: {
  value: StoreAppDeployOptionsValue;
  onChange: (value: StoreAppDeployOptionsValue) => void;
  tenantId: string | null;
  disabled?: boolean;
}) {
  const set = <K extends keyof StoreAppDeployOptionsValue>(
    key: K,
    v: StoreAppDeployOptionsValue[K],
  ) => onChange({ ...value, [key]: v });

  const groupNeeded = value.assignmentMode === "group";
  const assignmentOptions =
    value.runAsAccount === "user"
      ? ASSIGNMENT_OPTIONS.filter((o) => USER_ASSIGNMENT_MODES.includes(o.id))
      : ASSIGNMENT_OPTIONS;

  return (
    <div className="space-y-4">
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
          disabled={disabled}
        />
      </div>

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
          disabled={disabled}
        >
          <option value="system">System</option>
          <option value="user">User</option>
        </select>
      </div>

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
