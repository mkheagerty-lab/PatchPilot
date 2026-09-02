import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  tables,
  demoDevices,
  demoDeviceVulnerabilities,
  demoDeviceExclusions,
  type DeviceExclusionRow,
  type DeviceRow,
} from "@patchpilot/db";
import {
  DEVICE_EXCLUSION_JUSTIFICATIONS,
  DEVICE_EXCLUSION_JUSTIFICATION_LABELS,
  isDeviceExclusionJustification,
  isExclusionLive,
  type DeviceExclusionJustification,
  type PreflightDevice,
} from "@patchpilot/shared";
import { audit } from "@patchpilot/graph";
import { config } from "../config.js";
import { requirePermission } from "../auth/rbac.js";

/**
 * Device exclusion routes — PatchPilot's mirror of the Defender portal's
 * Assets > Devices > Exclude.
 *
 * Deliberately a close copy of the recommendation-exception block in
 * routes/recommendations.ts, for the same reason it exists: **Defender exposes
 * no write API for device exclusion.** `PATCH /api/machines/{id}` can update
 * only `machineTags` and `deviceValue`; there is no "exclude" machine action and
 * no Graph entity for it. So this table records the engineer's intent and drives
 * PatchPilot's own views — the engineer still applies the matching exclusion by
 * hand in the Defender portal.
 *   https://learn.microsoft.com/en-us/defender-endpoint/api/update-machine-method
 *   https://learn.microsoft.com/en-us/defender-endpoint/exclude-devices
 *
 * Reading Defender's own exclusion state back is *possible*, but not from the
 * `Machine` resource `syncDevices` already reads. `IsExcluded`, `ExclusionReason`
 * and `IsTransient` live on the advanced-hunting `DeviceInfo` table, reachable
 * only via `POST /security/runHuntingQuery`. Mirroring them would mean a new
 * `ThreatHunting.Read.All` scope and fresh admin consent in every customer
 * tenant, and it silently degrades on Defender for Business, where advanced
 * hunting is not available (P2/E5 only). That is the seam if two-way parity is
 * ever wanted; it is deliberately not wired up today.
 *   https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-deviceinfo-table
 *
 * One way PatchPilot goes *further* than Defender: Defender's exclusion is
 * visibility-only, ours also blocks remediation. See the `device-excluded`
 * check in packages/shared/src/preflight.ts.
 */

export { DEVICE_EXCLUSION_JUSTIFICATIONS };

/** Derived read-time status — "expired" is computed, never stored. */
type DerivedStatus = "active" | "cancelled" | "expired";

const derivedStatus = (e: DeviceExclusionRow): DerivedStatus =>
  isExclusionLive(e) ? "active" : e.status === "cancelled" ? "cancelled" : "expired";

/** "Out of scope — decommissioned in June", for chips and preflight details. */
export function exclusionReason(e: DeviceExclusionRow): string {
  const label = DEVICE_EXCLUSION_JUSTIFICATION_LABELS[e.justification];
  return e.notes ? `${label} — ${e.notes}` : label;
}

/**
 * Every exclusion still in force.
 *
 * Unlike `loadActiveExceptions`, `tenantId` is optional and omitting it returns
 * every tenant's rows. The Devices page is routinely viewed in all-tenants mode,
 * and the exception read paths skip filtering entirely in that mode (see
 * recommendations.ts and data.ts) — repeating that here would make excluded
 * devices reappear on the one list they must never reappear on. The table is
 * tiny (one row per excluded device, ever), so loading it whole is cheap.
 */
export async function loadActiveExclusions(tenantId?: string): Promise<DeviceExclusionRow[]> {
  const rows = config.DEMO_MODE
    ? demoDeviceExclusions.filter((e) => !tenantId || e.tenantId === tenantId)
    : await db
        .select()
        .from(tables.deviceExclusions)
        .where(tenantId ? eq(tables.deviceExclusions.tenantId, tenantId) : undefined);
  return rows.filter((e) => isExclusionLive(e));
}

/**
 * Active exclusions joined to their device rows, keyed every way a caller might
 * hold a device.
 *
 * Three keys because the fleet tables disagree about what a device is:
 * `device_vulnerabilities` and `device_software` key off `defenderMachineId`,
 * jobs and the detail routes off the `devices.id` uuid, and the exclusion itself
 * off `managedDeviceId` (see the schema comment for why it is not a uuid FK).
 *
 * Keys are bare ids rather than tenant-qualified: all three are GUIDs or Defender
 * machine hashes, and the load is already scoped when a tenantId is supplied.
 */
export interface ExcludedDeviceIndex {
  byManagedDeviceId: Map<string, DeviceExclusionRow>;
  byDeviceId: Map<string, DeviceExclusionRow>;
  byMachineId: Map<string, DeviceExclusionRow>;
  /** Nothing excluded — lets callers skip filtering work altogether. */
  isEmpty: boolean;
}

const EMPTY_INDEX: ExcludedDeviceIndex = {
  byManagedDeviceId: new Map(),
  byDeviceId: new Map(),
  byMachineId: new Map(),
  isEmpty: true,
};

export async function loadExcludedDeviceIndex(tenantId?: string): Promise<ExcludedDeviceIndex> {
  const exclusions = await loadActiveExclusions(tenantId);
  if (exclusions.length === 0) return EMPTY_INDEX;

  const byManagedDeviceId = new Map<string, DeviceExclusionRow>();
  for (const e of exclusions) byManagedDeviceId.set(e.managedDeviceId, e);

  const managedIds = [...byManagedDeviceId.keys()];
  const deviceRows: DeviceRow[] = config.DEMO_MODE
    ? demoDevices.filter((d) => byManagedDeviceId.has(d.managedDeviceId))
    : await db
        .select()
        .from(tables.devices)
        .where(inArray(tables.devices.managedDeviceId, managedIds));

  const byDeviceId = new Map<string, DeviceExclusionRow>();
  const byMachineId = new Map<string, DeviceExclusionRow>();
  for (const d of deviceRows) {
    const e = byManagedDeviceId.get(d.managedDeviceId);
    if (!e) continue;
    // Guard the all-tenants load: two tenants could in principle carry the same
    // id, and hiding the wrong tenant's device would be a silent data error.
    if (e.tenantId !== d.tenantId) continue;
    byDeviceId.set(d.id, e);
    if (d.defenderMachineId) byMachineId.set(d.defenderMachineId, e);
  }

  return { byManagedDeviceId, byDeviceId, byMachineId, isEmpty: false };
}

/** Key for the excluded-exposure map. `|` is safe: tenant ids are GUIDs. */
export const excludedExposureKey = (tenantId: string, software: string): string =>
  `${tenantId}|${software.trim().toLowerCase()}`;

/**
 * Distinct excluded machines exposed to each `(tenant, software)` pair.
 *
 * Backs the coverage tables in routes/catalog.ts and routes/chocolatey-catalog.ts,
 * which group vulnerabilities the same way. Those two files are deliberately
 * duplicated of each other, but this is exclusion logic rather than catalog
 * logic, so it lives here once instead of a third and fourth time.
 *
 * Only the excluded machines' `device_vulnerabilities` rows are read, so the cost
 * scales with the number of excluded devices rather than the fleet. It feeds a
 * **subtraction**, never a recomputation: `affectedDeviceCount` is Defender's own
 * number and the local join table is a sparser view of the same fleet, so
 * replacing it outright would silently shrink real findings.
 */
export async function loadExcludedExposureBySoftware(
  excluded: ExcludedDeviceIndex,
): Promise<Map<string, Set<string>>> {
  const bySoftware = new Map<string, Set<string>>();
  if (excluded.isEmpty) return bySoftware;
  const machineIds = [...excluded.byMachineId.keys()];
  if (machineIds.length === 0) return bySoftware;

  const rows: { tenantId: string; software: string; defenderMachineId: string }[] = config.DEMO_MODE
    ? demoDeviceVulnerabilities.filter((dv) => machineIds.includes(dv.defenderMachineId))
    : await db
        .select({
          tenantId: tables.deviceVulnerabilities.tenantId,
          software: tables.deviceVulnerabilities.software,
          defenderMachineId: tables.deviceVulnerabilities.defenderMachineId,
        })
        .from(tables.deviceVulnerabilities)
        .where(inArray(tables.deviceVulnerabilities.defenderMachineId, machineIds));

  for (const r of rows) {
    // Cross-tenant guard: the index may span tenants (see loadActiveExclusions),
    // and a machine only counts against the tenant its exclusion belongs to.
    if (excluded.byMachineId.get(r.defenderMachineId)?.tenantId !== r.tenantId) continue;
    const key = excludedExposureKey(r.tenantId, r.software);
    (bySoftware.get(key) ?? bySoftware.set(key, new Set()).get(key)!).add(r.defenderMachineId);
  }
  return bySoftware;
}

/**
 * The device fields every dispatch route already has in hand — a structural
 * subset of `DeviceRow` so callers can pass a narrowed select just as easily as
 * a full row.
 */
export interface PreflightDeviceSource {
  id: string;
  hostname: string;
  managedDeviceId: string;
  defenderMachineId: string | null;
  compliance: "compliant" | "noncompliant" | "unknown";
  lastSeen: Date | null;
}

/**
 * Builds the `PreflightDevice` every dispatch path feeds to `preflight()`.
 *
 * Centralised so the exclusion flag cannot be forgotten at one of the eight
 * call sites — the whole point of making `PreflightDevice.excluded` required
 * was that missing it should be impossible, and eight hand-written copies of
 * the same object literal is how it becomes possible again.
 */
export function toPreflightDevice(
  d: PreflightDeviceSource,
  excluded: ExcludedDeviceIndex,
): PreflightDevice {
  const e = excluded.byManagedDeviceId.get(d.managedDeviceId);
  return {
    id: d.id,
    hostname: d.hostname,
    managedDeviceId: d.managedDeviceId,
    defenderMachineId: d.defenderMachineId,
    compliance: d.compliance,
    lastSeen: d.lastSeen ? d.lastSeen.toISOString() : null,
    excluded: Boolean(e),
    exclusionReason: e ? exclusionReason(e) : null,
  };
}

/** Cap on a review date, same 1-year ceiling the exception route enforces. */
const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Resolves `expiresAt` from the request body.
 *
 * Returns `null` — never expires — when the body says nothing, which is the
 * Defender default and the modal's default. `undefined` signals a bad value.
 */
function resolveExpiry(body: {
  expiresAt?: string | null;
  durationDays?: number | null;
}): Date | null | undefined {
  if (body.expiresAt) {
    const at = new Date(body.expiresAt);
    if (Number.isNaN(at.getTime()) || at.getTime() - Date.now() > MAX_DURATION_MS) return undefined;
    return at;
  }
  if (body.durationDays) {
    if (!Number.isFinite(body.durationDays) || body.durationDays <= 0) return undefined;
    const at = new Date(Date.now() + body.durationDays * 24 * 60 * 60 * 1000);
    if (at.getTime() - Date.now() > MAX_DURATION_MS) return undefined;
    return at;
  }
  return null;
}

/** The devices being excluded, so the hostname snapshot is ours and not the client's. */
async function loadDevicesForExclusion(
  tenantId: string,
  managedDeviceIds: string[],
): Promise<DeviceRow[]> {
  if (config.DEMO_MODE) {
    return demoDevices.filter(
      (d) => d.tenantId === tenantId && managedDeviceIds.includes(d.managedDeviceId),
    );
  }
  return db
    .select()
    .from(tables.devices)
    .where(
      and(
        eq(tables.devices.tenantId, tenantId),
        inArray(tables.devices.managedDeviceId, managedDeviceIds),
      ),
    );
}

/** Existing active rows for these devices, to be superseded. */
async function loadSupersededExclusions(
  tenantId: string,
  managedDeviceIds: string[],
): Promise<DeviceExclusionRow[]> {
  const rows = config.DEMO_MODE
    ? demoDeviceExclusions.filter(
        (e) => e.tenantId === tenantId && managedDeviceIds.includes(e.managedDeviceId),
      )
    : await db
        .select()
        .from(tables.deviceExclusions)
        .where(
          and(
            eq(tables.deviceExclusions.tenantId, tenantId),
            inArray(tables.deviceExclusions.managedDeviceId, managedDeviceIds),
          ),
        );
  return rows.filter((e) => e.status === "active");
}

export async function deviceExclusionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.session.engineer) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
  });
  app.addHook("preHandler", requirePermission("operations:read"));

  // List — drives the Exclusion state filter's "Excluded" view and the
  // exclusion-details panel. tenantId is optional here for the same reason
  // loadActiveExclusions makes it optional: the Devices page has an
  // all-tenants mode and the list has to keep working in it.
  app.get<{ Querystring: { tenantId?: string } }>("/api/device-exclusions", async (req) => {
    const tenantId = req.query.tenantId;
    const rows = config.DEMO_MODE
      ? demoDeviceExclusions.filter((e) => !tenantId || e.tenantId === tenantId)
      : await db
          .select()
          .from(tables.deviceExclusions)
          .where(tenantId ? eq(tables.deviceExclusions.tenantId, tenantId) : undefined);

    return [...rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r, derivedStatus: derivedStatus(r) }));
  });

  interface CreateExclusionBody {
    tenantId?: string;
    /** Single-device form. */
    managedDeviceId?: string;
    /** Bulk form — Defender supports bulk exclusion and the table needs it. */
    managedDeviceIds?: string[];
    justification?: string;
    notes?: string;
    /** Omit both for "never expires" (Defender parity). */
    durationDays?: number | null;
    expiresAt?: string | null;
  }

  /**
   * Creates one exclusion per device, superseding any active row for the same
   * device first — Defender's stated behaviour is that re-excluding a device
   * overrides the previous justification. The superseding cancel is what keeps
   * "at most one active exclusion per device" true without a partial unique
   * index (see the schema comment).
   */
  async function createExclusions(
    engineer: string,
    tenantId: string,
    devices: DeviceRow[],
    justification: DeviceExclusionJustification,
    notes: string | null,
    expiresAt: Date | null,
  ): Promise<DeviceExclusionRow[]> {
    const managedIds = devices.map((d) => d.managedDeviceId);
    const superseded = await loadSupersededExclusions(tenantId, managedIds);
    const now = new Date();

    if (superseded.length > 0) {
      if (config.DEMO_MODE) {
        for (const e of superseded) {
          e.status = "cancelled";
          e.cancelledAt = now;
        }
      } else {
        await db
          .update(tables.deviceExclusions)
          .set({ status: "cancelled", cancelledAt: now })
          .where(
            inArray(
              tables.deviceExclusions.id,
              superseded.map((e) => e.id),
            ),
          );
      }
    }

    const rows: DeviceExclusionRow[] = devices.map((d) => ({
      id: randomUUID(),
      tenantId,
      managedDeviceId: d.managedDeviceId,
      deviceHostname: d.hostname,
      justification,
      notes,
      expiresAt,
      status: "active" as const,
      createdBy: engineer,
      createdAt: now,
      cancelledAt: null,
    }));

    if (config.DEMO_MODE) {
      demoDeviceExclusions.unshift(...rows);
    } else {
      await db.insert(tables.deviceExclusions).values(rows);
    }

    // One audit entry per device, so the log stays queryable per device rather
    // than collapsing a bulk exclusion into a single unsearchable row.
    const until = expiresAt ? ` until ${expiresAt.toISOString().slice(0, 10)}` : " indefinitely";
    for (const row of rows) {
      await audit({
        engineer,
        tenantId,
        // Synthetic, non-Graph endpoint: this is a local record only. PatchPilot
        // never calls Defender for it — there is no API to call.
        endpoint: "device-exclusion:create",
        method: "POST",
        action: "device:exclude",
        resourceType: "device",
        resourceId: row.managedDeviceId,
        resourceLabel: row.deviceHostname,
        summary: `Excluded ${row.deviceHostname} (${DEVICE_EXCLUSION_JUSTIFICATION_LABELS[justification]})${until}`,
        outcome: "success",
        payload: { managedDeviceId: row.managedDeviceId, justification, notes },
        responseStatus: 201,
      });
    }

    return rows;
  }

  /** Shared by the single and bulk endpoints — they differ only in arity. */
  async function handleCreate(
    req: FastifyRequest<{ Body: CreateExclusionBody }>,
    reply: FastifyReply,
    managedDeviceIds: string[],
  ) {
    const body = req.body ?? {};
    const { tenantId, justification } = body;
    if (!tenantId || !justification) {
      return reply.code(400).send({ error: "tenantId and justification are required" });
    }
    if (managedDeviceIds.length === 0) {
      return reply.code(400).send({ error: "at least one managedDeviceId is required" });
    }
    if (!isDeviceExclusionJustification(justification)) {
      return reply.code(400).send({ error: "invalid justification" });
    }

    const expiresAt = resolveExpiry(body);
    if (expiresAt === undefined) {
      return reply.code(400).send({ error: "expiresAt must be a valid date within 1 year" });
    }

    // Resolve hostnames server-side rather than trusting the client — the
    // snapshot has to be a true record of what was excluded, since it is all
    // that survives once syncDevices drops the device row.
    const devices = await loadDevicesForExclusion(tenantId, managedDeviceIds);
    if (devices.length === 0) return reply.code(404).send({ error: "device_not_found" });

    const rows = await createExclusions(
      req.session.engineer!.upn,
      tenantId,
      devices,
      justification,
      body.notes?.trim() || null,
      expiresAt,
    );

    return reply.code(201).send({
      exclusions: rows.map((r) => ({ ...r, derivedStatus: "active" as const })),
      // Non-zero when a requested device no longer exists in the fleet — worth
      // surfacing rather than silently under-delivering on a bulk request.
      skipped: managedDeviceIds.length - devices.length,
    });
  }

  app.post<{ Body: CreateExclusionBody }>(
    "/api/device-exclusions",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) =>
      handleCreate(req, reply, req.body?.managedDeviceId ? [req.body.managedDeviceId] : []),
  );

  app.post<{ Body: CreateExclusionBody }>(
    "/api/device-exclusions/bulk",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => handleCreate(req, reply, req.body?.managedDeviceIds ?? []),
  );

  // Defender's "Stop exclusion". Soft cancel — the row stays as history so the
  // audit log's resourceId still resolves to something.
  app.post<{ Params: { id: string } }>(
    "/api/device-exclusions/:id/cancel",
    { preHandler: requirePermission("operations:write") },
    async (req, reply) => {
    const { id } = req.params;
    const engineer = req.session.engineer!.upn;

    const cancelAudit = async (row: DeviceExclusionRow) => {
      await audit({
        engineer,
        tenantId: row.tenantId,
        endpoint: "device-exclusion:cancel",
        method: "POST",
        action: "device:stop-exclusion",
        resourceType: "device",
        resourceId: row.managedDeviceId,
        resourceLabel: row.deviceHostname,
        summary: `Stopped the exclusion on ${row.deviceHostname}`,
        outcome: "success",
        payload: { id },
        responseStatus: 200,
      });
    };

    if (config.DEMO_MODE) {
      const row = demoDeviceExclusions.find((e) => e.id === id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      row.status = "cancelled";
      row.cancelledAt = new Date();
      await cancelAudit(row);
      return { ...row, derivedStatus: "cancelled" as const };
    }

    const [updated] = await db
      .update(tables.deviceExclusions)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(tables.deviceExclusions.id, id))
      .returning();
    if (!updated) return reply.code(404).send({ error: "not_found" });

    await cancelAudit(updated);
    return { ...updated, derivedStatus: "cancelled" as const };
    },
  );
}
