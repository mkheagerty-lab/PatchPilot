import { CLIENT_BUILDS, windowsLineForBuild } from "@patchpilot/shared";
import type { FeatureUpdateAssignmentKind, FeatureUpdateAssignmentSummary } from "@patchpilot/db";
import { graphGet, graphWrite, GraphError } from "./client.js";
import type { AssignmentTarget } from "./intune-apps.js";

/**
 * Intune Expedited Feature Update dispatch (Phase 5).
 *
 * Feature updates share the `deviceManagement` object family with quality
 * updates (`quality-updates.ts`) but are shaped differently: there is no
 * catalog-item lookup step (a feature-update profile targets a build/version
 * string directly, not a matched release id), and a group campaign is a
 * standing, date-scheduled rollout (`rolloutSettings`) rather than a one-time
 * push.
 *
 * There is no single-device entry point here (unlike quality updates):
 * `windowsFeatureUpdateProfiles/{id}/assign` has no per-device assignment
 * target at all — confirmed live against a real tenant, both
 * `allDevicesAssignmentTarget` (HTTP 400 "AllDevicesAssignmentTarget is not
 * supported") and the documented base `deviceAndAppManagementAssignmentTarget`
 * narrowed by an assignment filter (HTTP 500 from the Windows Update proxy
 * service) are rejected. A real Entra group is the only assignable target,
 * matching what the Intune admin center itself offers, so
 * `createAndAssignCampaignFeatureUpdateProfile` is the only entry point:
 * create a profile with a `rolloutSettings` block and assign it to a group
 * (built via `buildAssignmentTarget`/`resolveAssignmentTarget`).
 */

interface FeatureUpdateProfile {
  id: string;
}

/**
 * Graph's `featureUpdateVersion` field wants the human string Windows Update
 * itself shows, e.g. "Windows 11, version 24H2" — built from the same
 * CLIENT_BUILDS label used for display elsewhere, so the two never drift.
 */
function featureUpdateVersionString(targetBuild: number): string {
  const label = CLIENT_BUILDS[targetBuild];
  const line = windowsLineForBuild(targetBuild);
  return label ? `${line}, version ${label}` : line;
}

export interface CreateAndAssignCampaignFeatureUpdateProfileInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Engineer-supplied campaign name, used verbatim as the profile displayName. */
  displayName: string;
  /** Raw build number, already resolved via resolveTargetBuild(). */
  targetBuild: number;
  /** One or two real Entra group targets (buildAssignmentTargets with mode "group" and an optional excludeGroupId) — no filter needed for a group-wide rollout. */
  targets: AssignmentTarget[];
  offerStartDateTimeInUTC: string;
  offerEndDateTimeInUTC: string;
  offerIntervalInDays: number;
  installFeatureUpdatesOptional: boolean;
}

/**
 * Creates a `windowsFeatureUpdateProfile` with a `rolloutSettings` block
 * (Intune paces the rollout itself over the given window) and assigns it to a
 * real Entra group — unlike the single-device flow, no assignment filter is
 * needed since the group itself is the scope. Same create-vs-assign failure
 * distinction as the single-device function.
 */
export async function createAndAssignCampaignFeatureUpdateProfile(
  input: CreateAndAssignCampaignFeatureUpdateProfileInput,
): Promise<string> {
  const {
    engineer,
    homeTenantId,
    tenantId,
    displayName,
    targetBuild,
    targets,
    offerStartDateTimeInUTC,
    offerEndDateTimeInUTC,
    offerIntervalInDays,
    installFeatureUpdatesOptional,
  } = input;
  const versionString = featureUpdateVersionString(targetBuild);

  const created = await graphWrite<FeatureUpdateProfile>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: "/deviceManagement/windowsFeatureUpdateProfiles",
    body: {
      displayName,
      description: `Auto-provisioned by PatchPilot: scheduled feature-update campaign to ${versionString}.`,
      featureUpdateVersion: versionString,
      installFeatureUpdatesOptional,
      rolloutSettings: {
        offerStartDateTimeInUTC,
        offerEndDateTimeInUTC,
        offerIntervalInDays,
      },
    },
  });
  if (!created.ok || !created.data?.id) {
    const detail = created.errorBody ? ` — ${created.errorBody}` : "";
    throw new GraphError(
      created.status,
      `failed to create feature update campaign profile for ${versionString} (HTTP ${created.status})${detail}`,
    );
  }
  const profileId = created.data.id;

  const assigned = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: `/deviceManagement/windowsFeatureUpdateProfiles/${profileId}/assign`,
    body: {
      assignments: targets.map((target) => ({ target })),
    },
  });
  if (!assigned.ok) {
    const detail = assigned.errorBody ? ` — ${assigned.errorBody}` : "";
    throw new GraphError(
      assigned.status,
      `campaign profile ${profileId} was created but assignment failed (HTTP ${assigned.status})${detail} — it exists in Intune but targets no group.`,
    );
  }
  return profileId;
}

export interface DeleteFeatureUpdateProfileInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  intuneProfileId: string;
}

/**
 * Deletes a `windowsFeatureUpdateProfile` outright — the only way to actually
 * remove a campaign, whether PatchPilot created it or it was synced in from
 * the Intune admin center. A 404 is treated as success: the profile is
 * already gone, which is the same end state the caller wants, and matches how
 * `syncFeatureUpdateProfiles` already prunes rows Graph no longer reports.
 */
export async function deleteFeatureUpdateProfile(input: DeleteFeatureUpdateProfileInput): Promise<void> {
  const { engineer, homeTenantId, tenantId, intuneProfileId } = input;
  const res = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "DELETE",
    path: `/deviceManagement/windowsFeatureUpdateProfiles/${intuneProfileId}`,
  });
  if (!res.ok && res.status !== 404) {
    const detail = res.errorBody ? ` — ${res.errorBody}` : "";
    throw new GraphError(
      res.status,
      `failed to delete feature update campaign profile ${intuneProfileId} (HTTP ${res.status})${detail}`,
    );
  }
}

/**
 * Live-sync half of this module (Phase 5 follow-up): reads back every
 * `windowsFeatureUpdateProfile` that already exists in the tenant's Intune,
 * whether PatchPilot created it or not. `listFeatureUpdateProfiles` is the
 * counterpart to `createAndAssignCampaignFeatureUpdateProfile` above — the
 * only place in the codebase that GETs this object type instead of just
 * POSTing to it. `syncFeatureUpdateProfiles` (apps/api/src/graph/sync.ts) is
 * the only caller: it upserts each row on (tenantId, intuneProfileId) and
 * prunes rows Graph no longer reports.
 */

interface RawAssignmentTarget {
  "@odata.type"?: string;
  groupId?: string;
}

interface RawAssignment {
  target?: RawAssignmentTarget;
}

interface RawRolloutSettings {
  offerStartDateTimeInUTC?: string;
  offerEndDateTimeInUTC?: string;
  offerIntervalInDays?: number;
}

interface RawFeatureUpdateProfile {
  id: string;
  displayName?: string;
  featureUpdateVersion?: string;
  installFeatureUpdatesOptional?: boolean;
  rolloutSettings?: RawRolloutSettings;
  assignments?: RawAssignment[];
}

export interface ListFeatureUpdateProfilesInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
}

/** Mirrors client.ts's HOSTS — used only to turn an absolute `@odata.nextLink` back into the relative path `graphGet` expects. */
const BETA_HOST_BASE = "https://graph.microsoft.com/beta";

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_PROFILE_PAGES = 20;

/**
 * Paginated walk of the tenant's feature-update profiles, `$expand=assignments`
 * so each profile's real Intune-admin-center-set targets come back in the same
 * call. **Not yet live-verified**: whether `$expand=assignments` is honored on
 * the *list* call the way it is for some other deviceManagement profile types,
 * or whether it silently no-ops and each profile needs its own follow-up
 * `GET .../{id}?$expand=assignments`. Ship this first; if a live tenant comes
 * back with profiles that have assignments in the Intune admin center but an
 * empty `assignments` array here, switch to the per-profile fallback (bounded
 * by profile count, which is always small).
 */
async function* iterateFeatureUpdateProfilePages(
  input: ListFeatureUpdateProfilesInput,
): AsyncGenerator<RawFeatureUpdateProfile[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const select = "id,displayName,featureUpdateVersion,installFeatureUpdatesOptional,rolloutSettings";
  let path: string | null = `/deviceManagement/windowsFeatureUpdateProfiles?$select=${select}&$expand=assignments`;
  let pages = 0;

  while (path && pages < MAX_PROFILE_PAGES) {
    const res: Awaited<
      ReturnType<typeof graphGet<{ value?: RawFeatureUpdateProfile[]; "@odata.nextLink"?: string }>>
    > = await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list feature-update profiles (HTTP ${res.status})${res.errorBody ? `: ${res.errorBody}` : ""}`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE, "") : null;
    pages++;
  }
}

export interface ResolveGroupNamesInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  groupIds: string[];
}

/**
 * Resolves a small set of group ids to display names. An assignment target
 * only ever carries a bare `groupId` — PatchPilot's own creation flow records
 * the name client-side at creation time (the picker already has it), but a
 * profile synced in from Intune has no such record, so the sync itself has to
 * look names up to render anything better than a bare GUID. Individual GETs,
 * not `$batch` — a profile's assignment count is always small (rarely more
 * than one include and one exclude group).
 */
export async function resolveGroupNames(input: ResolveGroupNamesInput): Promise<Map<string, string>> {
  const { engineer, homeTenantId, tenantId, groupIds } = input;
  const unique = Array.from(new Set(groupIds));
  const names = new Map<string, string>();
  await Promise.all(
    unique.map(async (groupId) => {
      const res = await graphGet<{ id: string; displayName?: string }>({
        engineer,
        homeTenantId,
        tenantId,
        path: `/groups/${groupId}?$select=id,displayName`,
      });
      if (res.ok && res.data?.displayName) {
        names.set(groupId, res.data.displayName);
      }
      // A 404 (deleted group) or any other failure just leaves this id unresolved —
      // the caller renders a bare id rather than failing the whole sync over one
      // stale/inaccessible group reference.
    }),
  );
  return names;
}

/** Reused by quality-updates.ts/update-rings.ts/driver-updates.ts's own list functions — every deviceManagement profile type encodes assignment targets the same way. */
export function assignmentKindFromODataType(type: string | undefined): FeatureUpdateAssignmentKind | null {
  switch (type) {
    case "#microsoft.graph.groupAssignmentTarget":
      return "include";
    case "#microsoft.graph.exclusionGroupAssignmentTarget":
      return "exclude";
    case "#microsoft.graph.allDevicesAssignmentTarget":
      return "all-devices";
    case "#microsoft.graph.allLicensedUsersAssignmentTarget":
      return "all-users";
    default:
      // An assignment target type this codebase doesn't yet model — dropped
      // rather than guessed at, so the UI never shows a fabricated kind.
      return null;
  }
}

/**
 * Reverse of `featureUpdateVersionString()` above: pulls the CLIENT_BUILDS
 * label back out of Graph's raw `"Windows 11, version 24H2"` string. Unlike
 * `resolveTargetBuild()` (which falls back to the latest known build for an
 * unrecognized label — the right call when resolving a *new* campaign's
 * default target), a profile synced in from Intune that targets a version
 * PatchPilot doesn't recognize must surface as `null`, not silently get
 * attributed to the latest build.
 */
function parseFeatureUpdateVersionLabel(raw: string): number | null {
  const match = raw.match(/version\s+(\S+)\s*$/i);
  const label = match?.[1];
  if (!label) return null;
  const entry = Object.entries(CLIENT_BUILDS).find(([, l]) => l === label);
  return entry ? Number(entry[0]) : null;
}

export interface FeatureUpdateProfileSummary {
  intuneProfileId: string;
  displayName: string;
  targetVersion: string;
  targetBuild: number | null;
  assignments: FeatureUpdateAssignmentSummary[];
  installFeatureUpdatesOptional: boolean;
  offerStartDateTimeInUTC: string | null;
  offerEndDateTimeInUTC: string | null;
  offerIntervalInDays: number | null;
}

/**
 * Every `windowsFeatureUpdateProfile` in the tenant's Intune, mapped to a
 * `feature_update_campaigns` row shape — the live-sync counterpart to
 * `createAndAssignCampaignFeatureUpdateProfile`. Covers both a profile
 * PatchPilot itself created and one that pre-dated onboarding or was created
 * directly in the Intune admin center; the two are indistinguishable from
 * this call alone (Graph doesn't record who made a profile through PatchPilot
 * vs. the admin center) — `syncFeatureUpdateProfiles` (apps/api) is what tells
 * them apart, by never overwriting an existing row's `source` column.
 */
export async function listFeatureUpdateProfiles(
  input: ListFeatureUpdateProfilesInput,
): Promise<FeatureUpdateProfileSummary[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const raw: RawFeatureUpdateProfile[] = [];
  for await (const page of iterateFeatureUpdateProfilePages(input)) {
    raw.push(...page);
  }

  const groupIds = new Set<string>();
  for (const profile of raw) {
    for (const assignment of profile.assignments ?? []) {
      if (assignment.target?.groupId) groupIds.add(assignment.target.groupId);
    }
  }
  const groupNames = groupIds.size
    ? await resolveGroupNames({ engineer, homeTenantId, tenantId, groupIds: Array.from(groupIds) })
    : new Map<string, string>();

  return raw.map((profile) => {
    const assignments: FeatureUpdateAssignmentSummary[] = [];
    for (const assignment of profile.assignments ?? []) {
      const kind = assignmentKindFromODataType(assignment.target?.["@odata.type"]);
      if (!kind) continue;
      const groupId = assignment.target?.groupId;
      assignments.push(groupId ? { kind, groupId, groupName: groupNames.get(groupId) } : { kind });
    }

    const versionString = profile.featureUpdateVersion ?? "";
    const rollout = profile.rolloutSettings;

    return {
      intuneProfileId: profile.id,
      displayName: profile.displayName?.trim() || "(untitled)",
      targetVersion: versionString,
      targetBuild: versionString ? parseFeatureUpdateVersionLabel(versionString) : null,
      assignments,
      installFeatureUpdatesOptional: profile.installFeatureUpdatesOptional ?? false,
      offerStartDateTimeInUTC: rollout?.offerStartDateTimeInUTC ?? null,
      offerEndDateTimeInUTC: rollout?.offerEndDateTimeInUTC ?? null,
      offerIntervalInDays: rollout?.offerIntervalInDays ?? null,
    };
  });
}
