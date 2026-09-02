import type { IntuneAssignmentSummary } from "@patchpilot/db";
import { graphGet, GraphError } from "./client.js";
import { assignmentKindFromODataType, resolveGroupNames } from "./feature-updates.js";

/**
 * Read-only live-sync of `windowsUpdateForBusinessConfiguration` ("Update
 * rings" in the Intune admin center) — Phase 5's Windows Updates hub. No
 * PatchPilot create/delete path exists for this resource, so unlike
 * feature-updates.ts/quality-updates.ts this file only ever lists. Mirrors
 * `listFeatureUpdateProfiles` in feature-updates.ts exactly: paginated,
 * `$expand=assignments`, group-id -> name resolution via the shared
 * `resolveGroupNames`.
 *
 * Unlike windowsFeatureUpdateProfiles/windowsQualityUpdateProfiles, there is
 * no standalone `windowsUpdateForBusinessConfigurations` collection — Graph
 * confirmed this live (400 "Resource not found for the segment"). Update
 * rings are one of several polymorphic subtypes stored in the general
 * `deviceConfigurations` collection, so listing them means filtering that
 * collection down to this one `@odata.type` via `isof(...)`. `$select` is
 * deliberately omitted since it's unclear whether it's honored against a cast
 * filter on a polymorphic collection — every field below is read optionally
 * off whatever the full object comes back as instead.
 */

interface RawAssignmentTarget {
  "@odata.type"?: string;
  groupId?: string;
}

interface RawAssignment {
  target?: RawAssignmentTarget;
}

interface RawUpdateRingProfile {
  id: string;
  displayName?: string;
  assignments?: RawAssignment[];
  qualityUpdatesDeferralPeriodInDays?: number;
  featureUpdatesDeferralPeriodInDays?: number;
  allowWindows11Upgrade?: boolean;
  automaticUpdateMode?: string;
  businessReadyUpdatesOnly?: string;
}

export interface ListUpdateRingProfilesInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
}

/** Mirrors client.ts's HOSTS — used only to turn an absolute `@odata.nextLink` back into the relative path `graphGet` expects. */
const BETA_HOST_BASE = "https://graph.microsoft.com/beta";

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_PROFILE_PAGES = 20;

async function* iterateUpdateRingProfilePages(
  input: ListUpdateRingProfilesInput,
): AsyncGenerator<RawUpdateRingProfile[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const filter = encodeURIComponent("isof('microsoft.graph.windowsUpdateForBusinessConfiguration')");
  let path: string | null = `/deviceManagement/deviceConfigurations?$filter=${filter}&$expand=assignments`;
  let pages = 0;

  while (path && pages < MAX_PROFILE_PAGES) {
    const res: Awaited<
      ReturnType<typeof graphGet<{ value?: RawUpdateRingProfile[]; "@odata.nextLink"?: string }>>
    > = await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list update ring profiles (HTTP ${res.status})${res.errorBody ? `: ${res.errorBody}` : ""}`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE, "") : null;
    pages++;
  }
}

export interface UpdateRingProfileSummary {
  intuneProfileId: string;
  displayName: string;
  assignments: IntuneAssignmentSummary[];
  qualityUpdatesDeferralPeriodInDays: number | null;
  featureUpdatesDeferralPeriodInDays: number | null;
  allowWindows11Upgrade: boolean | null;
  automaticUpdateMode: string | null;
  businessReadyUpdatesOnly: string | null;
}

export async function listUpdateRingProfiles(
  input: ListUpdateRingProfilesInput,
): Promise<UpdateRingProfileSummary[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const raw: RawUpdateRingProfile[] = [];
  for await (const page of iterateUpdateRingProfilePages(input)) {
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
    const assignments: IntuneAssignmentSummary[] = [];
    for (const assignment of profile.assignments ?? []) {
      const kind = assignmentKindFromODataType(assignment.target?.["@odata.type"]);
      if (!kind) continue;
      const groupId = assignment.target?.groupId;
      assignments.push(groupId ? { kind, groupId, groupName: groupNames.get(groupId) } : { kind });
    }

    return {
      intuneProfileId: profile.id,
      displayName: profile.displayName?.trim() || "(untitled)",
      assignments,
      qualityUpdatesDeferralPeriodInDays: profile.qualityUpdatesDeferralPeriodInDays ?? null,
      featureUpdatesDeferralPeriodInDays: profile.featureUpdatesDeferralPeriodInDays ?? null,
      allowWindows11Upgrade: profile.allowWindows11Upgrade ?? null,
      automaticUpdateMode: profile.automaticUpdateMode ?? null,
      businessReadyUpdatesOnly: profile.businessReadyUpdatesOnly ?? null,
    };
  });
}
