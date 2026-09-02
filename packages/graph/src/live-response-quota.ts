import { and, eq, sql } from "drizzle-orm";
import { db, tables } from "@patchpilot/db";
import { env } from "./env.js";
import { resolveEffectiveEntitlement } from "./entitlement.js";

/**
 * PatchPilot's Live Response device quota. The vendor issues one
 * instance-wide pool of devices (`entitlement.deviceLicensePool` — see
 * ./entitlement.ts); the MSP's own admin decides how that pool is split
 * across tenants (`tenants.liveResponseDeviceLimit`, set via Settings >
 * Tenants, enforced there to never let the sum of every tenant's allocation
 * exceed the pool — see apps/api/src/routes/data.ts). This module only cares
 * about the per-tenant allocation, not the pool itself: by the time a
 * tenant has a nonzero `liveResponseDeviceLimit`, the pool math has already
 * been enforced at allocation time.
 *
 * "Counts against quota" = a distinct device dispatched-to at least once for
 * that tenant (see `entitlement_device_usage`).
 *
 * Two entry points, mirroring the existing exclusion/readOnly pattern:
 *  - `checkLiveResponseDeviceQuota` — read-only, used by `preflight()`'s
 *    dry-run report (via `PreflightInput.liveResponseQuota`) so an engineer
 *    sees this gate before clicking Fix Now.
 *  - `reserveLiveResponseDeviceSlot` — the authoritative, last-mile check AND
 *    the actual quota consumption, called from `apps/worker/src/executor.ts`
 *    immediately before dispatch. A job enqueued but never executed must
 *    never consume a slot, so the reservation happens here, not at enqueue
 *    time.
 */

function quotaExceededReason(deviceLimit: number): string {
  if (deviceLimit === 0) {
    return "This tenant has no Live Response device allocation. An admin can allocate some of the instance's device pool to it under Settings → Tenants.";
  }
  return `This tenant has reached its allocated Live Response device quota (${deviceLimit} device${
    deviceLimit === 1 ? "" : "s"
  }). An admin can raise its allocation under Settings → Tenants, or target a device already within quota.`;
}

async function isDeviceAlreadyCounted(tenantId: string, deviceId: string): Promise<boolean> {
  const [existing] = await db
    .select({ deviceId: tables.entitlementDeviceUsage.deviceId })
    .from(tables.entitlementDeviceUsage)
    .where(
      and(
        eq(tables.entitlementDeviceUsage.tenantId, tenantId),
        eq(tables.entitlementDeviceUsage.deviceId, deviceId),
      ),
    )
    .limit(1);
  return Boolean(existing);
}

async function loadTenantDeviceLimit(tenantId: string): Promise<number> {
  const [row] = await db
    .select({ liveResponseDeviceLimit: tables.tenants.liveResponseDeviceLimit })
    .from(tables.tenants)
    .where(eq(tables.tenants.tenantId, tenantId))
    .limit(1);
  // No tenant row at all is not expected on this path (preflight/executor
  // already resolved the tenant by here) — fail closed rather than throw.
  return row?.liveResponseDeviceLimit ?? 0;
}

/**
 * Read-only pre-check: would dispatching Live Response to this device right
 * now fit within the tenant's allocated quota? A device already counted for
 * this tenant is always within quota — the cap only ever applies to a
 * genuinely new device.
 */
export async function checkLiveResponseDeviceQuota(
  tenantId: string,
  deviceId: string,
): Promise<{ allowed: boolean; reason: string }> {
  if (env.DEMO_MODE) {
    return { allowed: true, reason: "Demo mode — no Live Response device quota enforced." };
  }

  const effective = await resolveEffectiveEntitlement();
  if (effective.unlimited) {
    return { allowed: true, reason: "Unlimited tier — no Live Response device quota enforced." };
  }

  if (await isDeviceAlreadyCounted(tenantId, deviceId)) {
    return { allowed: true, reason: "Device already counted against this tenant's quota." };
  }

  const deviceLimit = await loadTenantDeviceLimit(tenantId);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tables.entitlementDeviceUsage)
    .where(eq(tables.entitlementDeviceUsage.tenantId, tenantId));
  const count = row?.count ?? 0;

  if (count >= deviceLimit) {
    return { allowed: false, reason: quotaExceededReason(deviceLimit) };
  }
  return { allowed: true, reason: "New device is within this tenant's remaining Live Response device quota." };
}

/**
 * Authoritative, last-mile check + reservation, called immediately before an
 * actual Live Response dispatch. On pass, atomically records/bumps usage —
 * this INSERT is both the record and the actual quota consumption. A race
 * between two different newly-seen devices for the same tenant both passing
 * the pre-check when only one slot remains is an accepted soft-limit edge
 * case (see the plan), not worth a distributed lock.
 */
export async function reserveLiveResponseDeviceSlot(
  tenantId: string,
  device: { id: string; managedDeviceId: string; hostname: string },
): Promise<{ allowed: boolean; reason: string }> {
  if (env.DEMO_MODE) {
    return { allowed: true, reason: "Demo mode — no Live Response device quota enforced." };
  }

  const check = await checkLiveResponseDeviceQuota(tenantId, device.id);
  if (!check.allowed) return check;

  await db
    .insert(tables.entitlementDeviceUsage)
    .values({
      tenantId,
      deviceId: device.id,
      managedDeviceId: device.managedDeviceId,
      deviceHostname: device.hostname,
    })
    .onConflictDoUpdate({
      target: [tables.entitlementDeviceUsage.tenantId, tables.entitlementDeviceUsage.deviceId],
      set: {
        lastDispatchedAt: new Date(),
        dispatchCount: sql`${tables.entitlementDeviceUsage.dispatchCount} + 1`,
      },
    });

  return { allowed: true, reason: "Reserved." };
}
