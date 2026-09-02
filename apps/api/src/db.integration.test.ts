import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { db, schema, eq } from "@patchpilot/db";

/**
 * Runs against a real Postgres (patchpilot_test — see
 * vitest.integration.config.ts and src/test/integration-global-setup.ts),
 * not the mocked db client every other *.test.ts in this app uses. Exists to
 * catch what a mock can't: a renamed/dropped column, a broken unique
 * constraint, or a jsonb default that doesn't actually round-trip as an
 * array once Postgres is involved.
 *
 * tenantId is randomised per run and always cleaned up in `finally`, so a
 * crashed run leaves at most an orphaned throwaway row in patchpilot_test —
 * never in patchpilot, and never colliding with a future run.
 */
describe("tenants table (real Postgres)", () => {
  it("round-trips insert -> unique constraint -> update -> read -> delete", async () => {
    const tenantId = `test-tenant-${randomUUID()}`;
    try {
      const [inserted] = await db
        .insert(schema.tenants)
        .values({ tenantId, displayName: "Integration Test Tenant" })
        .returning();
      expect(inserted?.consentStatus).toBe("pending");
      expect(inserted?.readOnly).toBe(true);
      expect(inserted?.licenses).toEqual([]);

      // tenantId is the join key used everywhere else in the schema (see
      // tenant-key-is-entra-tenantid) — this constraint is load-bearing, and a
      // mocked test would never notice if a migration accidentally dropped it.
      await expect(
        db.insert(schema.tenants).values({ tenantId, displayName: "Duplicate" }),
      ).rejects.toThrow();

      await db
        .update(schema.tenants)
        .set({ readOnly: false, licenses: ["intune", "mde-p2"] })
        .where(eq(schema.tenants.tenantId, tenantId));

      const [updated] = await db
        .select()
        .from(schema.tenants)
        .where(eq(schema.tenants.tenantId, tenantId));
      expect(updated?.readOnly).toBe(false);
      expect(updated?.licenses).toEqual(["intune", "mde-p2"]);
    } finally {
      await db.delete(schema.tenants).where(eq(schema.tenants.tenantId, tenantId));
    }

    const [gone] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.tenantId, tenantId));
    expect(gone).toBeUndefined();
  });
});
