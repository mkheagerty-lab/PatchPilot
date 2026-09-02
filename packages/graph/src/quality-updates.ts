import type { IntuneAssignmentSummary } from "@patchpilot/db";
import { graphGet, graphWrite, GraphError } from "./client.js";
import type { AssignmentTarget } from "./intune-apps.js";
import { assignmentKindFromODataType, resolveGroupNames } from "./feature-updates.js";

/**
 * Intune Expedited Quality Update dispatch (Phase 5).
 *
 * Three Graph/Intune primitives, composed by the worker's `expedited-quality-update`
 * executor to turn a Defender missing-KB id into a real, single-device-scoped
 * Windows Update policy:
 *
 *  1. `findQualityUpdateCatalogItem` — match the KB id to an Intune catalog item.
 *  2. `ensureDeviceAssignmentFilter` — Intune assignment has no device-id target
 *     type, so a per-device hostname filter is how a profile is scoped to one
 *     machine instead of the whole tenant.
 *  3. `createAndAssignQualityUpdateProfile` — create the profile for the matched
 *     release and assign it to a caller-supplied target (single-device filter
 *     or, for group campaigns, a real Entra group).
 *
 * Lives in `packages/graph` (not apps/api or apps/worker) because both the api
 * (read routes that want to show "is this KB expeditable?") and the worker (the
 * actual dispatch) need it — same sharing rationale as client.ts itself.
 */

/** One Windows version/build's specific revision within a catalog item's release. */
interface CatalogProductRevision {
  displayName?: string;
  versionName?: string;
  productName?: string;
  osBuild?: {
    majorVersionNumber?: number;
    minorVersionNumber?: number;
    buildNumber?: number;
    updateBuildRevision?: number;
  };
  knowledgeBaseArticle?: {
    articleId?: string;
    articleUrl?: string;
  };
}

export interface QualityUpdateCatalogItem {
  id: string;
  displayName?: string;
  /**
   * NOT a KB number, despite the name — confirmed live against BLACK IRON this
   * holds an OS build string (e.g. `"10.0.22621.1265"`) or is empty on
   * pre-2023 items. The real, per-Windows-version KB numbers (`"KB5041580"`)
   * only live inside `productRevisions[].knowledgeBaseArticle.articleId`.
   */
  kbArticleId?: string;
  isExpeditable?: boolean;
  classification?: string;
  releaseDateTime?: string;
  productRevisions?: CatalogProductRevision[];
}

export interface FindCatalogItemInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** Defender's missing-KB `id` (bare number, no "KB" prefix) — matched against each `productRevisions[].knowledgeBaseArticle.articleId`. */
  kbId: string;
}

/** Mirrors client.ts's HOSTS — used only to turn an absolute `@odata.nextLink` back into the relative path `graphGet` expects. */
const BETA_HOST_BASE = "https://graph.microsoft.com/beta";

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_CATALOG_PAGES = 20;

/** Escapes a single-quoted OData string literal (`'` -> `''`). */
function odataQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function matchesKb(item: QualityUpdateCatalogItem, kbId: string): boolean {
  const target = `KB${kbId}`.toUpperCase();
  return (item.productRevisions ?? []).some(
    (rev) => rev.knowledgeBaseArticle?.articleId?.toUpperCase() === target,
  );
}

/**
 * Public wrapper over `matchesKb` — lets the release-picker route flag which
 * item in `listQualityUpdateCatalogItems`'s result is the one the caller's
 * specific Defender KB id already resolves to, without duplicating the
 * productRevisions-matching logic.
 */
export function catalogItemMatchesKb(item: QualityUpdateCatalogItem, kbId: string): boolean {
  return matchesKb(item, kbId);
}

export interface ListCatalogItemsInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
}

/**
 * Shared pagination walker behind both `findQualityUpdateCatalogItem` and
 * `listQualityUpdateCatalogItems` — same `isof(...)`-filtered path, same
 * `@odata.nextLink` handling, same `MAX_CATALOG_PAGES` guard. Lazy (async
 * generator) so a caller that stops early (a KB match) never fetches pages
 * beyond the one where it found what it needed.
 *
 * Throws on a failed page fetch rather than silently ending the walk — a
 * transient Graph error (expired token, 429, 503) on page 1 used to come back
 * from `listQualityUpdateCatalogItems` indistinguishable from "this tenant's
 * catalog is genuinely empty", which surfaced in the UI as a false "No
 * expeditable releases found" even though the tenant's real Intune catalog had
 * releases. Live-observed against BLACK IRON: identical KB, identical device,
 * failed once then succeeded minutes later with no code change — a transport
 * blip, not an empty catalog. Callers that want a soft "not found" (e.g. no
 * catalog item synced yet) already get that from a `null`/empty *result*, not
 * from swallowing a genuine fetch failure.
 */
async function* iterateCatalogPages(
  input: ListCatalogItemsInput,
): AsyncGenerator<QualityUpdateCatalogItem[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const filter = "isof('microsoft.graph.windowsQualityUpdateCatalogItem')";
  let path: string | null = `/deviceManagement/windowsUpdateCatalogItems?$filter=${encodeURIComponent(filter)}`;
  let pages = 0;

  while (path && pages < MAX_CATALOG_PAGES) {
    const res: Awaited<ReturnType<typeof graphGet<{ value?: QualityUpdateCatalogItem[]; "@odata.nextLink"?: string }>>> =
      await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list quality-update catalog (HTTP ${res.status})`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE, "") : null;
    pages++;
  }
}

/**
 * Looks up the Intune Windows Update catalog item matching a Defender missing-KB
 * id.
 *
 * Live-verified against BLACK IRON that the obvious server-side filter —
 * `kbArticleId eq '<kbId>'` — is doubly broken: Graph 400s on the bare property
 * name next to `isof()` (a derived-type property reference needs the full cast
 * path), and even cast-qualified, `kbArticleId` never holds a KB number anyway
 * (see the field's doc comment above). So this walks the tenant's quality-update
 * catalog (isof-filtered only; small — roughly one item per month) and matches
 * client-side against each item's `productRevisions[]`, which is where the real,
 * per-Windows-version KB numbers live. Returns whatever it finds — including a
 * match with `isExpeditable: false` — so the caller can give an honest "found
 * but not expeditable" reason rather than a generic "not found"; a null return
 * means the catalog was fetched successfully but has no item for this KB
 * (including: not yet synced into this tenant's Intune catalog, which live
 * testing showed lags real KB releases by a meaningful margin) — a failed
 * fetch throws instead (see `iterateCatalogPages`), so a null here is never a
 * disguised transport error.
 */
export async function findQualityUpdateCatalogItem(
  input: FindCatalogItemInput,
): Promise<QualityUpdateCatalogItem | null> {
  const { kbId } = input;
  for await (const page of iterateCatalogPages(input)) {
    const match = page.find((item) => matchesKb(item, kbId));
    if (match) return match;
  }
  return null;
}

/**
 * Returns every item in the tenant's quality-update catalog — the release
 * picker's data source. Unlike `findQualityUpdateCatalogItem`, walks every
 * page unconditionally (no early exit), since the caller wants the full list.
 */
export async function listQualityUpdateCatalogItems(
  input: ListCatalogItemsInput,
): Promise<QualityUpdateCatalogItem[]> {
  const items: QualityUpdateCatalogItem[] = [];
  for await (const page of iterateCatalogPages(input)) {
    items.push(...page);
  }
  return items;
}

/**
 * Parses the monthly ("B") vs out-of-band ("OOB") release cadence letter
 * embedded in a catalog item's `displayName` (e.g. `"09/10/2024 - 2024.09 B
 * SecurityUpdate for Windows 10 and later"`). No typed/structured cadence
 * field exists anywhere in the catalog schema — this is the only signal.
 * BLACK IRON's synced catalog has only ever shown "B"-labeled items live; the
 * "OOB" naming pattern below is inferred from Microsoft's published release
 * conventions, not live-observed — reconfirm against a real OOB item (or
 * current Microsoft Learn docs) the first time one appears, and treat
 * `"unknown"` as a safe, honest fallback rather than guessing further.
 */
export function parseReleaseCadence(item: QualityUpdateCatalogItem): "B" | "OOB" | "unknown" {
  const name = item.displayName ?? "";
  if (/\bOOB\b/i.test(name)) return "OOB";
  if (/\bB\b/.test(name)) return "B";
  return "unknown";
}

/**
 * Parses the `MM/DD/YYYY` date prefix off a catalog item's `displayName`
 * (e.g. `"08/11/2026 - 2026.08 B SecurityUpdate..."`). `releaseDateTime` is
 * in fact populated in synced data (confirmed live against BLACK IRON, and
 * now also used verbatim as the `qualityUpdateRelease` value in
 * `createAndAssignQualityUpdateProfile` below) — this displayName parse
 * remains the release-picker's date source purely for historical reasons,
 * not because the field is missing.
 * Returns `null` when the prefix is missing/malformed so callers can treat an
 * undated item as "never latest" rather than crashing or guessing.
 */
export function parseReleaseDate(item: QualityUpdateCatalogItem): Date | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(item.displayName ?? "");
  if (!match) return null;
  const [, month, day, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

interface AssignmentFilter {
  id: string;
  displayName: string;
}

export interface EnsureAssignmentFilterInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /** The device's synced hostname — must be unique within the tenant to uniquely target it (Intune does not enforce this). */
  hostname: string;
}

const FILTER_NAME_PREFIX = "PatchPilot-Device-";

function filterDisplayName(hostname: string): string {
  return `${FILTER_NAME_PREFIX}${hostname}`;
}

/**
 * Ensures a per-device Intune assignment filter exists, matching only this
 * device by hostname (`device.deviceName -eq "<hostname>"`) — Intune assignment
 * has no device-id target type, so a single-device-scoped filter is the only way
 * to scope a profile assignment to one machine. Idempotent: looks up by a
 * content-addressed display name (`PatchPilot-Device-<hostname>`) before
 * creating, so a second dispatch against the same device reuses the filter
 * rather than accumulating duplicates.
 */
export async function ensureDeviceAssignmentFilter(input: EnsureAssignmentFilterInput): Promise<string> {
  const { engineer, homeTenantId, tenantId, hostname } = input;
  const displayName = filterDisplayName(hostname);

  const listed = await graphGet<{ value?: AssignmentFilter[] }>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    path: `/deviceManagement/assignmentFilters?$filter=${encodeURIComponent(`displayName eq '${odataQuote(displayName)}'`)}`,
  });
  const existing = listed.ok ? (listed.data?.value ?? [])[0] : undefined;
  if (existing?.id) return existing.id;

  const created = await graphWrite<AssignmentFilter>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: "/deviceManagement/assignmentFilters",
    body: {
      displayName,
      description:
        "Auto-provisioned by PatchPilot to scope an Expedited Quality Update profile to one device.",
      platform: "windows10AndLater",
      rule: `(device.deviceName -eq "${hostname}")`,
      assignmentFilterManagementType: "devices",
    },
  });
  if (!created.ok || !created.data?.id) {
    throw new GraphError(
      created.status,
      `failed to create assignment filter for device ${hostname} (HTTP ${created.status})`,
    );
  }
  return created.data.id;
}

export interface CreateAndAssignProfileInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  /**
   * The matched catalog item's own `id` (not `kbArticleId`). Despite its
   * name, `expeditedUpdateSettings.qualityUpdateRelease` does NOT accept this
   * id directly — Graph 400s on it with an opaque, non-diagnostic error.
   * Live-verified against BLACK IRON: it wants the item's `releaseDateTime`
   * (ISO 8601) instead. `createAndAssignQualityUpdateProfile` re-fetches the
   * catalog to resolve `catalogItemId` -> `releaseDateTime` before building
   * the create request.
   */
  catalogItemId: string;
  /** Defender KB id, used for the profile's auto-generated display name (when `displayName` is omitted) and in error messages. */
  kbId: string;
  /** User-chosen profile name; falls back to the existing auto-generated `"PatchPilot Expedited Update - KB<kbId> - <timestamp>"` string when omitted. */
  displayName?: string;
  /** 0/1/2-day reboot-enforcement window, matching Intune admin center's own range. Defaults to `2`, today's hardcoded value. */
  daysUntilForcedReboot?: 0 | 1 | 2;
  /** Assignment targets — either a single-device filter target (`ensureDeviceAssignmentFilter` + `buildAssignmentTargets({mode:"all-devices",filterId})`, Fix Now/Fix All's existing per-device behavior) or one or two real Entra group targets (`buildAssignmentTargets({mode:"group",groupId,excludeGroupId})`, Fix All's group-campaign path — include and exclude are independent, so this can carry both). */
  targets: AssignmentTarget[];
}

interface QualityUpdateProfile {
  id: string;
}

/**
 * Resolves a catalog item's `id` to its `releaseDateTime` — the value Graph
 * actually wants in `expeditedUpdateSettings.qualityUpdateRelease` (live-verified
 * against BLACK IRON; the item's own `id` 400s there with an opaque error).
 * Re-walks the catalog rather than a direct by-id GET because
 * `windowsUpdateCatalogItems/{id}` also 400s (same derived-type-cast class of
 * issue as the other endpoints in this file) — the isof-filtered list is the
 * only reliable read path for this resource.
 */
async function resolveQualityUpdateRelease(input: {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  catalogItemId: string;
}): Promise<string> {
  const { catalogItemId } = input;
  for await (const page of iterateCatalogPages(input)) {
    const match = page.find((item) => item.id === catalogItemId);
    if (match) {
      if (!match.releaseDateTime) {
        throw new GraphError(
          500,
          `catalog item ${catalogItemId} (${match.displayName ?? "unnamed"}) has no releaseDateTime — cannot build a quality update release reference`,
        );
      }
      return match.releaseDateTime;
    }
  }
  throw new GraphError(404, `catalog item ${catalogItemId} not found in tenant's quality-update catalog`);
}

/**
 * Creates a `windowsQualityUpdateProfile` targeting the matched catalog item's
 * release, then assigns it to the caller-supplied `target` — either an
 * "all devices" target narrowed by a per-device assignment filter (Fix
 * Now/Fix All's existing single-device behavior) or a real Entra group target
 * (Fix All's group-campaign path). One profile per dispatch: Intune has no
 * "add this device to an existing profile's target set" short of editing the
 * assignment, so each dispatch creates its own profile rather than trying to
 * reuse/mutate a shared one. Returns the new profile's id. Throws (rather
 * than silently degrading) on
 * either the create or assign write failing — a half-created, unassigned
 * profile left in the tenant is a real Intune-side artifact the caller/engineer
 * needs to know about, not something to swallow as "not performed".
 */
export async function createAndAssignQualityUpdateProfile(
  input: CreateAndAssignProfileInput,
): Promise<string> {
  const { engineer, homeTenantId, tenantId, catalogItemId, kbId, targets } = input;
  const displayName = input.displayName?.trim() || `PatchPilot Expedited Update - KB${kbId} - ${new Date().toISOString()}`;
  const daysUntilForcedReboot = input.daysUntilForcedReboot ?? 2;
  const qualityUpdateRelease = await resolveQualityUpdateRelease({
    engineer,
    homeTenantId,
    tenantId,
    catalogItemId,
  });

  const created = await graphWrite<QualityUpdateProfile>({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: "/deviceManagement/windowsQualityUpdateProfiles",
    body: {
      "@odata.type": "#microsoft.graph.windowsQualityUpdateProfile",
      displayName,
      description:
        "Auto-provisioned by PatchPilot to expedite installation of a single missing KB on one device.",
      expeditedUpdateSettings: {
        "@odata.type": "microsoft.graph.expeditedWindowsQualityUpdateSettings",
        qualityUpdateRelease,
        daysUntilForcedReboot,
      },
    },
  });
  if (!created.ok || !created.data?.id) {
    const detail = created.errorBody ? ` — ${created.errorBody}` : "";
    throw new GraphError(
      created.status,
      `failed to create quality update profile for KB ${kbId} (HTTP ${created.status})${detail}`,
    );
  }
  const profileId = created.data.id;

  const assigned = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "POST",
    path: `/deviceManagement/windowsQualityUpdateProfiles/${profileId}/assign`,
    body: {
      assignments: targets.map((target) => ({ target })),
    },
  });
  if (!assigned.ok) {
    const detail = assigned.errorBody ? ` — ${assigned.errorBody}` : "";
    throw new GraphError(
      assigned.status,
      `profile ${profileId} was created but assignment failed (HTTP ${assigned.status})${detail} — it exists in Intune but targets no device.`,
    );
  }
  return profileId;
}

export interface DeleteQualityUpdateProfileInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
  intuneProfileId: string;
}

/**
 * Deletes a `windowsQualityUpdateProfile` outright — mirrors
 * `deleteFeatureUpdateProfile` in feature-updates.ts exactly, including
 * treating a 404 as success (already gone is the end state the caller
 * wants). Only ever called for `policyType: "expedite"` rows — the newer
 * `windowsQualityUpdatePolicies` resource has no PatchPilot write path at
 * all, so there is no equivalent delete function for it.
 */
export async function deleteQualityUpdateProfile(input: DeleteQualityUpdateProfileInput): Promise<void> {
  const { engineer, homeTenantId, tenantId, intuneProfileId } = input;
  const res = await graphWrite({
    engineer,
    homeTenantId,
    tenantId,
    host: "beta",
    method: "DELETE",
    path: `/deviceManagement/windowsQualityUpdateProfiles/${intuneProfileId}`,
  });
  if (!res.ok && res.status !== 404) {
    const detail = res.errorBody ? ` — ${res.errorBody}` : "";
    throw new GraphError(
      res.status,
      `failed to delete quality update profile ${intuneProfileId} (HTTP ${res.status})${detail}`,
    );
  }
}

/**
 * Live-sync read-back of `windowsQualityUpdateProfiles` (the same resource
 * `createAndAssignQualityUpdateProfile` above writes to) — the "expedite"
 * half of the Quality Updates tab. Mirrors `listFeatureUpdateProfiles` in
 * feature-updates.ts exactly: paginated, `$expand=assignments`,
 * group-id -> name resolution via the shared `resolveGroupNames`.
 */

interface RawAssignmentTarget {
  "@odata.type"?: string;
  groupId?: string;
}

interface RawAssignment {
  target?: RawAssignmentTarget;
}

interface RawQualityUpdateProfile {
  id: string;
  displayName?: string;
  assignments?: RawAssignment[];
  expeditedUpdateSettings?: {
    qualityUpdateRelease?: string;
    daysUntilForcedReboot?: number;
  };
}

export interface ListQualityUpdateProfilesInput {
  engineer: string;
  homeTenantId: string;
  tenantId: string;
}

/** Mirrors client.ts's HOSTS — used only to turn an absolute `@odata.nextLink` back into the relative path `graphGet` expects. */
const BETA_HOST_BASE_PROFILES = "https://graph.microsoft.com/beta";

/** Guard against a pathological/looping `@odata.nextLink`. */
const MAX_PROFILE_PAGES = 20;

async function* iterateQualityUpdateProfilePages(
  input: ListQualityUpdateProfilesInput,
): AsyncGenerator<RawQualityUpdateProfile[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const select = "id,displayName,expeditedUpdateSettings";
  let path: string | null = `/deviceManagement/windowsQualityUpdateProfiles?$select=${select}&$expand=assignments`;
  let pages = 0;

  while (path && pages < MAX_PROFILE_PAGES) {
    const res: Awaited<
      ReturnType<typeof graphGet<{ value?: RawQualityUpdateProfile[]; "@odata.nextLink"?: string }>>
    > = await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list quality-update profiles (HTTP ${res.status})${res.errorBody ? `: ${res.errorBody}` : ""}`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE_PROFILES, "") : null;
    pages++;
  }
}

export interface QualityUpdateProfileSummary {
  intuneProfileId: string;
  displayName: string;
  releaseLabel: string | null;
  daysUntilForcedReboot: number | null;
  assignments: IntuneAssignmentSummary[];
}

/**
 * Every `windowsQualityUpdateProfile` in the tenant's Intune (the "expedite"
 * policyType) — the live-sync counterpart to `createAndAssignQualityUpdateProfile`.
 * Same PatchPilot-vs-Intune-origin ambiguity as `listFeatureUpdateProfiles`:
 * `syncQualityUpdateProfiles` (apps/api) is what tells them apart, by never
 * overwriting an existing row's `source` column.
 */
export async function listQualityUpdateProfiles(
  input: ListQualityUpdateProfilesInput,
): Promise<QualityUpdateProfileSummary[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const raw: RawQualityUpdateProfile[] = [];
  for await (const page of iterateQualityUpdateProfilePages(input)) {
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
      releaseLabel: profile.expeditedUpdateSettings?.qualityUpdateRelease ?? null,
      daysUntilForcedReboot: profile.expeditedUpdateSettings?.daysUntilForcedReboot ?? null,
      assignments,
    };
  });
}

/**
 * Live-sync read-back of `windowsQualityUpdatePolicies` — a **different,
 * newer Graph beta resource** from `windowsQualityUpdateProfiles` above, per
 * the user's own direction (not `windowsQualityUpdateProfiles` again). This
 * is genuinely new, currently-uncoded Graph territory: no prior call in this
 * codebase has ever hit this endpoint, so the field list below is a
 * best-guess from Microsoft Learn's documented shape, **not yet
 * live-verified** — same "flag the uncertainty explicitly" convention as
 * `iterateFeatureUpdateProfilePages`'s doc comment in feature-updates.ts. If
 * a live tenant 404s this path, comes back with a different field shape, or
 * `$expand=assignments` silently no-ops here, fix this function against that
 * evidence rather than the guess below. PatchPilot has no create/delete path
 * for this resource — every row is Intune-origin, read-only in the UI.
 */

interface RawQualityUpdatePolicy {
  id: string;
  displayName?: string;
  assignments?: RawAssignment[];
  deployableContentDisplayName?: string;
}

async function* iterateQualityUpdatePolicyPages(
  input: ListQualityUpdateProfilesInput,
): AsyncGenerator<RawQualityUpdatePolicy[]> {
  const { engineer, homeTenantId, tenantId } = input;
  let path: string | null = `/deviceManagement/windowsQualityUpdatePolicies?$expand=assignments`;
  let pages = 0;

  while (path && pages < MAX_PROFILE_PAGES) {
    const res: Awaited<
      ReturnType<typeof graphGet<{ value?: RawQualityUpdatePolicy[]; "@odata.nextLink"?: string }>>
    > = await graphGet({ engineer, homeTenantId, tenantId, host: "beta", path });
    if (!res.ok) {
      throw new GraphError(
        res.status,
        `failed to list quality-update policies (HTTP ${res.status})${res.errorBody ? `: ${res.errorBody}` : ""}`,
      );
    }

    yield res.data?.value ?? [];

    const next = res.data?.["@odata.nextLink"];
    path = next ? next.replace(BETA_HOST_BASE_PROFILES, "") : null;
    pages++;
  }
}

export async function listQualityUpdatePolicies(
  input: ListQualityUpdateProfilesInput,
): Promise<QualityUpdateProfileSummary[]> {
  const { engineer, homeTenantId, tenantId } = input;
  const raw: RawQualityUpdatePolicy[] = [];
  for await (const page of iterateQualityUpdatePolicyPages(input)) {
    raw.push(...page);
  }

  const groupIds = new Set<string>();
  for (const policy of raw) {
    for (const assignment of policy.assignments ?? []) {
      if (assignment.target?.groupId) groupIds.add(assignment.target.groupId);
    }
  }
  const groupNames = groupIds.size
    ? await resolveGroupNames({ engineer, homeTenantId, tenantId, groupIds: Array.from(groupIds) })
    : new Map<string, string>();

  return raw.map((policy) => {
    const assignments: IntuneAssignmentSummary[] = [];
    for (const assignment of policy.assignments ?? []) {
      const kind = assignmentKindFromODataType(assignment.target?.["@odata.type"]);
      if (!kind) continue;
      const groupId = assignment.target?.groupId;
      assignments.push(groupId ? { kind, groupId, groupName: groupNames.get(groupId) } : { kind });
    }

    return {
      intuneProfileId: policy.id,
      displayName: policy.displayName?.trim() || "(untitled)",
      releaseLabel: policy.deployableContentDisplayName ?? null,
      daysUntilForcedReboot: null,
      assignments,
    };
  });
}
