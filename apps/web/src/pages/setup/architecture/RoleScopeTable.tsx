import {
  HOME_TENANT_ROLE_PURPOSE,
  READONLY_GROUP_NAME,
  READONLY_GROUP_ROLES,
  REQUIRED_GDAP_ROLES,
  WRITE_GROUP_NAME,
  WRITE_GROUP_ROLES,
} from "@patchpilot/shared";

interface RoleRow {
  scope: "Home tenant" | "Customer tenant";
  role: string;
  mechanism: string;
  unlocks: string;
  permissions: readonly string[];
}

const CUSTOMER_ROLE_PURPOSE: Record<string, string> = {
  "Security Administrator": "Backs Defender for Endpoint's delegated write calls, scoped to that customer.",
  "Intune Administrator": "Backs Intune device/app/update-profile writes, scoped to that customer.",
  "Windows Update Deployment Administrator": "Backs Windows Update for Business deployment writes, scoped to that customer.",
  "Global Reader": "Reads users, groups, and licensing in that customer's tenant.",
};

/**
 * Which of PatchPilot's own requested delegated permissions (GRAPH_SCOPES /
 * DEFENDER_SCOPES, see packages/shared/src/scopes.ts) each Entra role backs.
 * Tenant-invariant — an Entra role unlocks the same underlying Graph/Defender
 * calls whether it's held via a home-tenant access group or a customer's
 * GDAP relationship, so one map covers both halves of the table below.
 * Prose-adjacent, not a formal 1:1 join (see HOME_TENANT_ROLE_PURPOSE's own
 * doc comment) — this lists the scopes most directly gated by each role.
 */
const ROLE_API_PERMISSIONS: Record<string, readonly string[]> = {
  "Global Reader": ["Organization.Read.All"],
  "Security Reader": ["SecurityEvents.Read.All"],
  "Security Administrator": ["Machine.LiveResponse", "Library.Manage"],
  "Intune Administrator": [
    "DeviceManagementManagedDevices.ReadWrite.All",
    "DeviceManagementConfiguration.ReadWrite.All",
    "DeviceManagementApps.ReadWrite.All",
  ],
  "Windows Update Deployment Administrator": ["WindowsUpdates.ReadWrite.All"],
};

const ROWS: RoleRow[] = [
  ...READONLY_GROUP_ROLES.map((role) => ({
    scope: "Home tenant" as const,
    role,
    mechanism: `${READONLY_GROUP_NAME} (auto-assigned)`,
    unlocks: HOME_TENANT_ROLE_PURPOSE[role],
    permissions: ROLE_API_PERMISSIONS[role] ?? [],
  })),
  ...WRITE_GROUP_ROLES.map((role) => ({
    scope: "Home tenant" as const,
    role,
    mechanism: `${WRITE_GROUP_NAME} (explicit toggle)`,
    unlocks: HOME_TENANT_ROLE_PURPOSE[role],
    permissions: ROLE_API_PERMISSIONS[role] ?? [],
  })),
  ...REQUIRED_GDAP_ROLES.map((role) => ({
    scope: "Customer tenant" as const,
    role,
    mechanism: "GDAP relationship (Partner Center)",
    unlocks: CUSTOMER_ROLE_PURPOSE[role] ?? "",
    permissions: ROLE_API_PERMISSIONS[role] ?? [],
  })),
];

export function RoleScopeTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <th className="px-5 py-3 font-medium">Scope</th>
            <th className="px-5 py-3 font-medium">Entra role</th>
            <th className="px-5 py-3 font-medium">Access mechanism</th>
            <th className="px-5 py-3 font-medium">What it unlocks</th>
            <th className="px-5 py-3 font-medium">PatchPilot API permissions</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={`${row.scope}-${row.role}`} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
              <td className="px-5 py-3 whitespace-nowrap text-slate-500 dark:text-slate-400">{row.scope}</td>
              <td className="px-5 py-3 whitespace-nowrap font-medium text-slate-700 dark:text-slate-200">{row.role}</td>
              <td className="px-5 py-3 whitespace-nowrap text-slate-600 dark:text-slate-300">{row.mechanism}</td>
              <td className="px-5 py-3 text-slate-600 dark:text-slate-300">{row.unlocks}</td>
              <td className="px-5 py-3">
                <div className="flex flex-wrap gap-1">
                  {row.permissions.map((p) => (
                    <span
                      key={p}
                      className="inline-flex items-center rounded bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-300"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
