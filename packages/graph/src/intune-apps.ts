import { graphGet, graphWrite, GraphError } from "./client.js";

/**
 * Intune mobile app assignment/edit primitives, shared by the WinGet
 * (Phase 1) and Win32 (Phase 2) app-deployment channels.
 *
 * Follows quality-updates.ts's conventions: plain async functions taking
 * `{ engineer, homeTenantId, tenantId, ... }`, calling graphGet/graphWrite,
 * throwing GraphError on any non-2xx write — a half-created or
 * half-assigned app is a real tenant-side artifact the caller needs to know
 * about, never something to swallow as "not performed".
 */

/** Escapes a single-quoted OData string literal (`'` -> `''`). */
function odataQuote(value: string): string {
  return value.replace(/'/g, "''");
}

export interface ResolveGroupIdByNameInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Exact, case-sensitive Entra group display name, as typed in the Deploy App form. */
  name: string;
}

export interface GroupLookupResult {
  id: string;
  displayName: string;
}

/**
 * Resolves a typed Entra group display name to its object id, for the Deploy
 * App form's "Assign to Custom Group"/"Exclude Groups" fields. Requires the
 * `Group.Read.All` delegated scope — a customer tenant that hasn't re-consented
 * since that scope was added will 403 here; callers should surface that as a
 * distinct "needs re-consent" state rather than the generic "group not found"
 * a null return implies, so a 403 is thrown while a genuine no-match returns
 * null.
 */
export async function resolveGroupIdByName(input: ResolveGroupIdByNameInput): Promise<string | null> {
  const { engineer, homeTenantId, tenantId, name } = input;
  const filter = `displayName eq '${odataQuote(name)}'`;
  const res = await graphGet<{ value?: GroupLookupResult[] }>({
    engineer,
    homeTenantId,
    tenantId,
    path: `/groups?$filter=${encodeURIComponent(filter)}`,
  });
  if (!res.ok) {
    throw new GraphError(res.status, `group lookup failed for "${name}" (HTTP ${res.status})`);
  }
  const match = (res.data?.value ?? [])[0];
  return match?.id ?? null;
}

export interface SearchGroupsInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Display-name prefix the engineer has typed so far. */
  query: string;
  top?: number;
}

/**
 * Searchable Entra group lookup backing the Include/Excluded Group pickers —
 * unlike `resolveGroupIdByName`'s exact match, this is a prefix search over
 * `displayName`, restricted to `securityEnabled` and mail-disabled groups
 * (mail-enabled/M365 groups aren't valid Intune assignment targets). The
 * `$filter`+`$orderby`+`$count` combination requires the `ConsistencyLevel:
 * eventual` header — Graph 400s without it.
 */
export async function searchGroups(input: SearchGroupsInput): Promise<GroupLookupResult[]> {
  const { engineer, homeTenantId, tenantId, query } = input;
  const top = input.top ?? 25;
  const filter = `startswith(displayName,'${odataQuote(query)}') and securityEnabled eq true and mailEnabled eq false`;
  const path =
    `/groups?$filter=${encodeURIComponent(filter)}&$orderby=displayName&$count=true` +
    `&$top=${top}&$select=id,displayName`;

  const res = await graphGet<{ value?: GroupLookupResult[] }>({
    engineer,
    homeTenantId,
    tenantId,
    path,
    headers: { ConsistencyLevel: "eventual" },
  });
  if (!res.ok) {
    throw new GraphError(res.status, `group search failed for "${query}" (HTTP ${res.status})`);
  }
  return res.data?.value ?? [];
}

export type AssignmentMode = "none" | "all-devices" | "all-users" | "group";

export interface BuildAssignmentTargetInput {
  mode: AssignmentMode;
  /** Required for "group" — the id the picker resolved. */
  groupId?: string;
  /** Optional per-device assignment filter id (ensureDeviceAssignmentFilter), narrowing an
   *  "all-devices"/"all-users"/"group" target to one device — the same trick expedited
   *  updates already uses. Not applied to the exclude target: excluding is already narrow. */
  filterId?: string;
  /** Independent of `mode` — settable simultaneously with any include target. Ignored when
   *  mode is "none" (excluding from nothing is meaningless). */
  excludeGroupId?: string;
}

export interface AssignmentTarget {
  "@odata.type": string;
  groupId?: string;
  deviceAndAppManagementAssignmentFilterId?: string;
  deviceAndAppManagementAssignmentFilterType?: "include" | "exclude";
}

/**
 * Pure: builds the Graph `target` payload array for an assignment. Unlike the
 * old single-target model, Include and Exclude are independent — a "group"
 * mode plus an `excludeGroupId` produces TWO entries in the same array, since
 * Intune models a simultaneous include+exclude as two assignment entries, not
 * a single target. Returns an empty array for "none" ("Do not Assign") — the
 * caller (assignMobileApp) treats an empty array as "clear all assignments"
 * rather than skipping the call, since Intune's assign action always replaces
 * the whole assignment list.
 */
export function buildAssignmentTargets(input: BuildAssignmentTargetInput): AssignmentTarget[] {
  const { mode, groupId, filterId, excludeGroupId } = input;
  const filterFields = filterId
    ? {
        deviceAndAppManagementAssignmentFilterId: filterId,
        deviceAndAppManagementAssignmentFilterType: "include" as const,
      }
    : {};

  const targets: AssignmentTarget[] = [];
  switch (mode) {
    case "none":
      break;
    case "all-devices":
      targets.push({ "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget", ...filterFields });
      break;
    case "all-users":
      targets.push({ "@odata.type": "#microsoft.graph.allLicensedUsersAssignmentTarget", ...filterFields });
      break;
    case "group":
      if (!groupId) throw new Error('buildAssignmentTargets: groupId is required for mode "group"');
      targets.push({ "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId, ...filterFields });
      break;
    default: {
      const exhaustive: never = mode;
      throw new Error(`buildAssignmentTargets: unknown mode ${String(exhaustive)}`);
    }
  }

  if (mode !== "none" && excludeGroupId) {
    targets.push({ "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: excludeGroupId });
  }

  return targets;
}

export interface AssignMobileAppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  appId: string;
  /** winGetApp/win32LobApp both accept "available" | "required"; "uninstall" is win32-only. */
  intent?: "available" | "required" | "uninstall";
  targets: AssignmentTarget[];
}

/**
 * `POST /deviceAppManagement/mobileApps/{appId}/assign`. Intune's assign
 * action REPLACES the whole assignment list — this is what makes "changing
 * the assignment on the fly" a matter of calling this again with the new
 * targets, not a diff/patch. `targets: []` ("Do not Assign") sends an empty
 * assignment list, clearing whatever was assigned before.
 */
export async function assignMobileApp(input: AssignMobileAppInput): Promise<void> {
  const { engineer, homeTenantId, tenantId, appId, targets } = input;
  const intent = input.intent ?? "required";
  const assignments = targets.map((target) => ({
    "@odata.type": "#microsoft.graph.mobileAppAssignment",
    intent,
    target,
  }));

  const res = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: `/deviceAppManagement/mobileApps/${appId}/assign`,
    body: { mobileAppAssignments: assignments },
  });
  if (!res.ok) {
    const detail = res.errorBody ? ` — ${res.errorBody}` : "";
    throw new GraphError(
      res.status,
      `app ${appId} was created but assignment failed (HTTP ${res.status})${detail} — it exists in Intune but targets nothing.`,
    );
  }
}

export interface MobileAppAssignment {
  intent?: string;
  target?: AssignmentTarget;
}

export interface MobileApp {
  id: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  installExperience?: { runAsAccount?: string };
  assignments?: MobileAppAssignment[];
  /** "notPublished" | "processing" | "published" — a winGetApp is built server-side
   *  after creation and can't be assigned until this reaches "published". */
  publishingState?: string;
  [key: string]: unknown;
}

export interface GetMobileAppInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  appId: string;
}

/**
 * Live-fetches the current state of an Intune mobile app, expanded with its
 * assignments — powers the Deploy App form's edit mode. Never cached: Name/
 * Description/Assignment are read fresh from Graph every time the form opens,
 * so there is no local copy that can drift from what Intune actually has.
 */
export async function getMobileApp(input: GetMobileAppInput): Promise<MobileApp | null> {
  const { engineer, homeTenantId, tenantId, appId } = input;
  const res = await graphGet<MobileApp>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    path: `/deviceAppManagement/mobileApps/${appId}?$expand=assignments`,
  });
  return res.ok ? res.data : null;
}

export interface WaitForAppPublishedInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  appId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * A freshly created winGetApp is built server-side (Intune resolves and
 * mirrors the package) before it can be assigned — an assign call made too
 * early 400s with "Invalid operation: app's PublishingState is not
 * 'Published'." Polls until publishingState flips to "published" or the
 * timeout elapses (returns false in that case; the app itself is unaffected,
 * assignment can just be retried later from the edit form).
 */
export async function waitForAppPublished(input: WaitForAppPublishedInput): Promise<boolean> {
  const { engineer, homeTenantId, tenantId, appId } = input;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const pollIntervalMs = input.pollIntervalMs ?? 4_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const app = await getMobileApp({ engineer, homeTenantId, tenantId, appId });
    if (app?.publishingState === "published") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export interface UpdateMobileAppMetadataInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  appId: string;
  /** The app's own @odata.type (e.g. "#microsoft.graph.winGetApp") — Graph requires it on a
   *  PATCH to the base mobileApps collection so it knows which derived-type properties apply. */
  odataType: string;
  displayName?: string;
  description?: string;
}

/**
 * `PATCH /deviceAppManagement/mobileApps/{appId}` — metadata-only edit
 * (Name/Description). Assignment changes go through assignMobileApp
 * separately, since Graph models them as different resources.
 *
 * Live-verified against BLACK IRON: Graph rejects any PATCH whose body
 * includes `installExperience` with "The property 'InstallExperience'
 * cannot be patched" — unconditionally, regardless of whether the value
 * actually changes. Install Behaviour (runAsAccount) is fixed at creation
 * time, same as Publisher — there is no way to edit it after the fact.
 */
export async function updateMobileAppMetadata(input: UpdateMobileAppMetadataInput): Promise<void> {
  const { engineer, homeTenantId, tenantId, appId, odataType, displayName, description } = input;

  const body: Record<string, unknown> = { "@odata.type": odataType };
  if (displayName !== undefined) body.displayName = displayName;
  if (description !== undefined) body.description = description;

  const res = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "PATCH",
    path: `/deviceAppManagement/mobileApps/${appId}`,
    body,
  });
  if (!res.ok) {
    const detail = res.errorBody ? ` — ${res.errorBody}` : "";
    throw new GraphError(
      res.status,
      `failed to update mobile app ${appId} metadata (HTTP ${res.status})${detail}`,
    );
  }
}
