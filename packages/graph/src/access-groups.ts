import { GraphError } from "./client.js";

/**
 * Home-tenant access-group membership management — the Entra-enforced
 * read-only/write split described in docs/onboarding-design.md's
 * "Home-tenant access groups" section. Deploy-PatchPilot.ps1 provisions two
 * role-assignable security groups in the home tenant (PatchPilot Read-Only
 * Access, PatchPilot Write Access); this module is what lets PatchPilot
 * itself add/remove an engineer's own Entra account from them.
 *
 * Same raw-fetch-bypass pattern as app-registration-sync.ts's graphFetch:
 * every function here takes an already-minted, one-shot step-up access
 * token as a parameter and never touches client.ts's `graphGet`/`graphWrite`
 * (which always resolve their own token from the standing per-engineer
 * cache in token-store.ts) — a tenant-wide User.Read.All/
 * GroupMember.ReadWrite.All grant must never be persisted as a standing
 * credential for silent reuse outside this narrow flow.
 */

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/**
 * Distinct from a generic GraphError so the API layer (routes handling the
 * access-group step-up callback) can render an actionable "ask a Global
 * Administrator" message instead of a raw error. Thrown specifically for a
 * 403 on a group-membership write — Microsoft's own enforcement that
 * modifying a role-assignable group's membership requires the *acting*
 * engineer's own Entra role to be Global Administrator or Privileged Role
 * Administrator (or already a member of the target group), which a
 * tenant-wide app consent grant cannot bypass. See the plan's own note on
 * this in docs/onboarding-design.md.
 */
export class AccessGroupPermissionError extends GraphError {
  constructor(message: string) {
    super(403, message);
    this.name = "AccessGroupPermissionError";
  }
}

async function graphFetch<T>(
  accessToken: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const message = `Graph ${method} ${path} failed (HTTP ${res.status})${text ? ` — ${text.slice(0, 500)}` : ""}`;
    if (res.status === 403) {
      throw new AccessGroupPermissionError(message);
    }
    throw new GraphError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Resolves an engineer's home-tenant Entra object ID from their UPN, so it
 * can be cached on the engineers row (entraObjectId) and reused for every
 * later group-membership call without a repeat lookup. homeTenantId is
 * accepted for symmetry with the rest of the Graph layer's per-tenant
 * functions and future-proofing, but is not used in the request itself —
 * the token passed in is already scoped to the home tenant by construction
 * (minted against ENTRA_TENANT_ID, never a customer tenant).
 */
export async function resolveEngineerObjectId(
  accessToken: string,
  homeTenantId: string,
  upn: string,
): Promise<string> {
  void homeTenantId;
  const user = await graphFetch<{ id: string }>(
    accessToken,
    "GET",
    `/users/${encodeURIComponent(upn)}?$select=id`,
  );
  return user.id;
}

/**
 * Adds an engineer to a role-assignable security group. Idempotent from the
 * caller's perspective: Graph's own "one or more objects belong to the same
 * resource" 400 is treated as success — the engineer is already a member,
 * which is the desired end state either way.
 */
export async function addToGroup(accessToken: string, groupId: string, engineerObjectId: string): Promise<void> {
  try {
    await graphFetch(accessToken, "POST", `/groups/${groupId}/members/$ref`, {
      "@odata.id": `${GRAPH_ROOT}/directoryObjects/${engineerObjectId}`,
    });
  } catch (err) {
    if (err instanceof GraphError && err.status === 400 && /already exist|one or more/i.test(err.message)) {
      return;
    }
    throw err;
  }
}

/**
 * Removes an engineer from a role-assignable security group. Graph 404s
 * (`/$ref` for a member that isn't present) are swallowed the same way —
 * "not a member" is the desired end state, not a failure.
 */
export async function removeFromGroup(accessToken: string, groupId: string, engineerObjectId: string): Promise<void> {
  try {
    await graphFetch(accessToken, "DELETE", `/groups/${groupId}/members/${engineerObjectId}/$ref`);
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) {
      return;
    }
    throw err;
  }
}
