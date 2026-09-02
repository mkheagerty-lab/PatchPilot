import type { IntuneAssignmentSummary } from "@patchpilot/db";
import { graphGet, GraphError } from "./client.js";
import { assignmentKindFromODataType, resolveGroupNames } from "./feature-updates.js";

/**
 * Read-only live-sync of `windowsDriverUpdateProfiles` ("Driver updates" in
 * the Intune admin center) — same rationale and shape as update-rings.ts:
 * no PatchPilot create/delete path, list-only.
 */

interface RawAssignmentTarget {
  "@odata.type"?: string;
  groupId?: string;
}

interface RawAssignment {
  target?: RawAssignmentTarget;
}

interface RawDriverUpdateProfile {
  id: string;
  displayName?: string;
  assignments?: RawAssignment[];
  approvalType?: string;
  deploymentDeferralInDays?: number;
}

export interface ListDriverUpdateProfilesInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
}

/** Mirrors client.ts's HOSTS — used only to turn an absolute `@odata.nextLink` back into the relative path `graphGet` expects. */
const BETA_HOST_BASE = "https://graph.microsoft.com/beta";

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_PROFILE_PAGES = 20;

async function* iterateDriverUpdateProfilePages(
  input: ListDriverUpdateProfilesInput,
): AsyncGenerator<RawDriverUpdateProfile[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const select = "id,displayName,approvalType,deploymentDeferralInDays";
  let path: string | null = `/deviceManagement/windowsDriverUpdateProfiles?$select=${select}&$expand=assignments`;
  let pages = 0;

  while (path && pages < MAX_PROFILE_PAGES) {
    const res: Awaited<
      ReturnType<typeof graphGet<{ value?: RawDriverUpdateProfile[]; "@odata.nextLink"?: string }>>
    > = await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list driver update profiles (HTTP ${res.status})${res.errorBody ? `: ${res.errorBody}` : ""}`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE, "") : null;
    pages++;
  }
}

export interface DriverUpdateProfileSummary {
  intuneProfileId: string;
  displayName: string;
  assignments: IntuneAssignmentSummary[];
  approvalType: string | null;
  deploymentDeferralInDays: number | null;
}

export async function listDriverUpdateProfiles(
  input: ListDriverUpdateProfilesInput,
): Promise<DriverUpdateProfileSummary[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const raw: RawDriverUpdateProfile[] = [];
  for await (const page of iterateDriverUpdateProfilePages(input)) {
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
      approvalType: profile.approvalType ?? null,
      deploymentDeferralInDays: profile.deploymentDeferralInDays ?? null,
    };
  });
}
