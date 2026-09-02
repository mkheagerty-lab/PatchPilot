/**
 * Seeds demo data into Postgres so the UI renders without live Graph calls.
 * Pulls from the same fixtures the API serves in DEMO_MODE (demo-data.ts), so
 * the seeded DB and the no-database demo show identical data.
 *
 * Idempotent: clears the demo tables first, upserts settings.
 */
import "./load-env.js"; // MUST be first: populates process.env from the root .env before the db client reads DATABASE_URL.
import { db, tables } from "./index.js";
import {
  demoTenants,
  demoDevices,
  demoDeviceVulnerabilities,
  demoVulnerabilities,
  demoRecommendations,
  demoWingetCatalog,
  demoJobs,
  demoSchedules,
  demoSla,
  demoBranding,
  demoAuditLog,
  demoPostureSnapshots,
  demoRemediationEvents,
} from "./demo-data.js";

const DEMO_TENANT_IDS = new Set(demoTenants.map((t) => t.tenantId));

// Refuses to run against a database that holds any tenant this script didn't
// itself seed — i.e. a real, Graph-discovered/synced tenant. Without this, a
// stray `npm run seed` against the live dev DB silently replaces real tenant
// data with fixtures (this has happened twice: the "msp-root" incidents).
async function assertSafeToSeed() {
  const existing = await db.select({ tenantId: tables.tenants.tenantId }).from(tables.tenants);
  const foreign = existing.filter((t) => !DEMO_TENANT_IDS.has(t.tenantId));
  if (foreign.length > 0) {
    console.error(
      `[db] refusing to seed: found ${foreign.length} tenant(s) that are not demo fixtures ` +
        `(${foreign.map((t) => t.tenantId).join(", ")}). This looks like a real, synced database — ` +
        "seeding would permanently delete this data. Aborting.",
    );
    process.exit(1);
  }
}

async function seed() {
  await assertSafeToSeed();

  console.log("[db] seeding demo data...");

  await db.delete(tables.postureSnapshots);
  await db.delete(tables.remediationEvents);
  await db.delete(tables.auditLog);
  await db.delete(tables.schedules);
  await db.delete(tables.jobs);
  await db.delete(tables.recommendations);
  await db.delete(tables.deviceVulnerabilities);
  await db.delete(tables.vulnerabilities);
  await db.delete(tables.devices);
  await db.delete(tables.wingetCatalog);
  await db.delete(tables.tenants);

  await db.insert(tables.tenants).values(demoTenants);
  await db.insert(tables.devices).values(demoDevices);
  await db.insert(tables.deviceVulnerabilities).values(demoDeviceVulnerabilities);
  await db.insert(tables.vulnerabilities).values(demoVulnerabilities);
  await db.insert(tables.recommendations).values(demoRecommendations);
  await db.insert(tables.wingetCatalog).values(demoWingetCatalog);
  await db.insert(tables.jobs).values(demoJobs);
  await db.insert(tables.schedules).values(demoSchedules);
  await db.insert(tables.auditLog).values(demoAuditLog);
  // Seeded last: these are generated relative to today's date (see demo-data.ts),
  // so re-seeding is also how a stale trend window gets refreshed.
  await db.insert(tables.postureSnapshots).values(demoPostureSnapshots);
  await db.insert(tables.remediationEvents).values(demoRemediationEvents);

  const settingRows = [
    { key: "sla", value: demoSla },
    { key: "branding", value: demoBranding },
  ];
  for (const row of settingRows) {
    await db
      .insert(tables.settings)
      .values(row)
      .onConflictDoUpdate({
        target: tables.settings.key,
        set: { value: row.value, updatedAt: new Date() },
      });
  }

  console.log("[db] seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
