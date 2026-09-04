/**
 * Canonical Microsoft API scopes PatchPilot requests, kept in sync with
 * scripts/patchpilot-app-manifest.json. SharePoint (Sites.ReadWrite.All) is
 * intentionally excluded per the "no SharePoint" non-negotiable.
 */

export const GRAPH_SCOPES = [
  "DelegatedAdminRelationship.Read.All",
  "DeviceManagementManagedDevices.ReadWrite.All",
  // managedDevice: syncDevice (win32-app channel's device-sync nudge) is
  // documented as requiring THIS scope specifically, not ReadWrite.All —
  // https://learn.microsoft.com/en-us/graph/api/intune-devices-manageddevice-syncdevice.
  // Without it every syncDevice call 403s even though ReadWrite.All covers
  // every other device-management read/write. Tenants that consented before
  // this was added need re-consent (same pattern as Group.Read.All below).
  "DeviceManagementManagedDevices.PrivilegedOperations.All",
  "DeviceManagementConfiguration.ReadWrite.All",
  "DeviceManagementApps.ReadWrite.All",
  "SecurityEvents.Read.All",
  "Vulnerability.Read.All",
  "WindowsUpdates.ReadWrite.All",
  // Reads /subscribedSkus for licensing detection. Without it the home-tenant
  // OBO licensing probe 403s, surfacing as a false "needs consent" reachability
  // and an empty Licenses column. (Customer tenants read SKUs via the GDAP
  // Global Reader role.)
  "Organization.Read.All",
  // Resolves a typed group name to its Entra object id for the Deploy App
  // form's "Assign to Custom Group"/"Exclude Groups" fields
  // (`GET /groups?$filter=displayName eq '<name>'`). Added after the initial
  // rollout — every already-onboarded customer tenant needs re-consent before
  // group-based Intune app assignment works there; the form degrades to a
  // clear "needs re-consent" notice rather than a raw 403 in the meantime.
  "Group.Read.All",
  "User.Read",
] as const;

export const DEFENDER_SCOPES = [
  "Machine.LiveResponse",
  // Lists and uploads Live Response *library* files. The Live Response channel
  // auto-provisions its parameterized winget remediation script into the tenant's
  // library (Defender only runs library scripts by name — inline execution isn't
  // supported), so onboarding needs no manual Defender-portal upload. Without it
  // the library list/upload 403s and the channel can't run.
  "Library.Manage",
  "Machine.Read.All",
  "Vulnerability.Read.All",
  // Reads /recommendations (Defender's TVM security recommendations) so the
  // Vulnerabilities surface can consolidate hundreds of per-CVE findings into one
  // actionable "Update <product>" row per software, the way the Defender portal
  // does. Without it the recommendations sync 403s and PatchPilot falls back to
  // the flat per-CVE list.
  "SecurityRecommendation.Read.All",
  // Reads /api/software and /api/machines/{id}/software (Defender's Software
  // Inventory), which is a separate permission from Vulnerability.Read.All.
  // Powers the Software Inventory page, including software Defender detects
  // but doesn't run CVE/weakness matching against. Added after the initial
  // rollout — customer tenants that already granted admin consent must
  // re-consent before their Software Inventory sync will succeed; until then
  // it 403s for that tenant.
  "Software.Read.All",
] as const;

export const PARTNER_CENTER_SCOPES = ["user_impersonation"] as const;

/**
 * The subset of GRAPH_SCOPES/DEFENDER_SCOPES that back Phase 5 remediation
 * writes rather than sync reads — mirrors Deploy-PatchPilot.ps1's
 * -EnableRemediationWriteScopes gate exactly. Kept here (derived from the
 * arrays above, not hand-duplicated) so the PowerShell flag, the in-app
 * "Sync permissions" toggle, and the request in onboarding.ts's report can
 * never drift from what GRAPH_SCOPES/DEFENDER_SCOPES actually declare.
 */
export const GRAPH_WRITE_GATED_SCOPES = [
  "DeviceManagementManagedDevices.ReadWrite.All",
  "DeviceManagementManagedDevices.PrivilegedOperations.All",
  "DeviceManagementConfiguration.ReadWrite.All",
  "DeviceManagementApps.ReadWrite.All",
  "WindowsUpdates.ReadWrite.All",
  "Group.Read.All",
] as const;

export const DEFENDER_WRITE_GATED_SCOPES = [
  "Machine.LiveResponse",
  "Library.Manage",
] as const;

/** Read-only-first (invariant #6) subset — what a fresh, non-write install requests. */
export const GRAPH_READONLY_SCOPES: readonly string[] = GRAPH_SCOPES.filter(
  (scope) => !(GRAPH_WRITE_GATED_SCOPES as readonly string[]).includes(scope),
);

export const DEFENDER_READONLY_SCOPES: readonly string[] = DEFENDER_SCOPES.filter(
  (scope) => !(DEFENDER_WRITE_GATED_SCOPES as readonly string[]).includes(scope),
);

/** GDAP roles that must be present in each customer tenant relationship. */
export const REQUIRED_GDAP_ROLES = [
  "Security Administrator",
  "Intune Administrator",
  "Windows Update Deployment Administrator",
  "Helpdesk Administrator",
  "Global Reader",
] as const;

/** Resource app ids for the three Microsoft APIs PatchPilot calls. */
export const RESOURCE_APP_IDS = {
  graph: "00000003-0000-0000-c000-000000000000",
  defender: "fc780465-2017-40d4-a0c5-307022471b92",
  partnerCenter: "fa3d9a0c-3fb0-42cc-9193-47c7ecd2edbd",
} as const;

/**
 * The exact scope sets `Deploy-PatchPilot.ps1` / "Sync permissions" would
 * request *right now*, for a given write-scopes preference — the drift
 * baseline compared against whatever was last actually written to the app
 * registration (see routes/onboarding.ts's `scopesSyncNeeded`). Sorted so two
 * baselines can be compared element-by-element regardless of array order.
 */
export interface ScopeBaseline {
  graph: string[];
  defender: string[];
  partnerCenter: string[];
}

export function currentScopeBaseline(includeWriteScopes: boolean): ScopeBaseline {
  return {
    graph: [...(includeWriteScopes ? GRAPH_SCOPES : GRAPH_READONLY_SCOPES)].sort(),
    defender: [...(includeWriteScopes ? DEFENDER_SCOPES : DEFENDER_READONLY_SCOPES)].sort(),
    partnerCenter: [...PARTNER_CENTER_SCOPES].sort(),
  };
}

function sameScopeList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function scopeBaselinesMatch(a: ScopeBaseline, b: ScopeBaseline): boolean {
  return (
    sameScopeList(a.graph, b.graph) &&
    sameScopeList(a.defender, b.defender) &&
    sameScopeList(a.partnerCenter, b.partnerCenter)
  );
}

/** Builds the per-customer admin consent URL (matches Deploy-PatchPilot.ps1). */
export function buildConsentUrl(
  customerTenantId: string,
  clientId: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "patchpilot-onboarding",
  });
  return `https://login.microsoftonline.com/${customerTenantId}/adminconsent?${params.toString()}`;
}
