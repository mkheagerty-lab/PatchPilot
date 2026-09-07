import { GraphError } from "./client.js";

/**
 * Check Access (Setup Health tab) — Graph reads backing Categories 2 (Entra
 * Roles Direct) and 3 (GDAP Roles, Partner Centre). See
 * packages/shared/src/check-access.ts for the summary shape these feed and
 * apps/api/src/routes/check-access.ts for how the two are assembled.
 *
 * Same raw-fetch, one-shot-token convention as access-groups.ts: every
 * function here takes an already-minted access token as a parameter and
 * never touches client.ts's `graphGet` (which always resolves its own token
 * from the standing per-engineer cache) — a tenant-wide CHECK_ACCESS_SCOPES
 * grant must never be persisted as a standing credential for silent reuse
 * outside this narrow flow.
 */

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

async function graphFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GraphError(res.status, `Graph GET ${path} failed (HTTP ${res.status})${text ? ` — ${text.slice(0, 500)}` : ""}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface GraphDirectoryRoleMembership {
  id: string;
  displayName?: string;
  /** Present only on directoryRole objects — absent for a group/other member type. */
  roleTemplateId?: string;
}

/**
 * A user's transitive directory-role AND group memberships in one call —
 * `/transitiveMemberOf` returns a mix of `#microsoft.graph.directoryRole` and
 * `#microsoft.graph.group` objects; callers filter by `roleTemplateId`
 * (present only on the former) to get just the directly-assigned roles
 * Category 2 cares about.
 *
 * `userIdOrMe` is `"me"` for a self-check (avoids needing the caller's own
 * object id) or a resolved Entra object id for an admin checking someone
 * else (see resolveEngineerObjectId in access-groups.ts).
 *
 * SPIKE ITEM (see the Check Access plan's Section 0): not yet live-confirmed
 * that RoleManagement.Read.Directory + User.Read.All together are sufficient
 * for `/users/{id}/transitiveMemberOf` — `/me/transitiveMemberOf` needs no
 * extra scope beyond standing login, but the `/users/{id}/...` form (used for
 * an admin checking someone else) may need one of these two explicitly.
 */
export async function getUserMemberships(
  accessToken: string,
  userIdOrMe: string,
): Promise<GraphDirectoryRoleMembership[]> {
  const base = userIdOrMe === "me" ? "/me" : `/users/${encodeURIComponent(userIdOrMe)}`;
  const page = await graphFetch<{ value: GraphDirectoryRoleMembership[] }>(
    accessToken,
    `${base}/transitiveMemberOf?$select=id,displayName,roleTemplateId`,
  );
  return page.value;
}

export interface GdapAccessAssignment {
  id: string;
  accessContainer: { accessContainerId: string; accessContainerType?: string };
  accessDetails: { unifiedRoles: { roleDefinitionId: string }[] };
}

/**
 * The security-group -> Entra-role mapping for one GDAP relationship —
 * Category 3 cross-references this against `getUserMemberships`'s group list
 * to confirm the target actually belongs to a group holding a required role,
 * not just that the relationship itself carries the role in the abstract.
 *
 * SPIKE ITEM (see the Check Access plan's Section 0): never called from this
 * codebase before — response shape above is Microsoft's documented schema,
 * not yet live-confirmed against the dev tenant. Also unconfirmed whether the
 * already-standing DelegatedAdminRelationship.Read.All scope covers this read
 * or whether it needs CHECK_ACCESS_SCOPES's RoleManagement.Read.Directory too.
 */
export async function getGdapAccessAssignments(
  accessToken: string,
  relationshipId: string,
): Promise<GdapAccessAssignment[]> {
  const page = await graphFetch<{ value: GdapAccessAssignment[] }>(
    accessToken,
    `/tenantRelationships/delegatedAdminRelationships/${encodeURIComponent(relationshipId)}/accessAssignments`,
  );
  return page.value;
}
