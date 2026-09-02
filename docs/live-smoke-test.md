# Live smoke test — real MSP tenant ingestion

Verifies the on-demand ingestion layer (Discover tenants → Sync data) against a
real Entra tenant with **`DEMO_MODE=false`**. Run after a real Microsoft login.

## Pre-conditions

- `.env` has `DEMO_MODE=false`, real `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` /
  `ENTRA_TENANT_ID`, and the redirect URI matching the running web port.
- `PUBLIC_URL` and `CORS_ORIGINS` are the **origin only** (e.g. `http://localhost:5173`),
  not the full `/auth/callback` URL — a path in `CORS_ORIGINS` never matches the
  browser's `Origin` header and blocks every API call.
- Postgres + Redis are up. For a host-run test use the **dev** stack, which
  publishes both on `localhost` with password `patchpilot`:
  `docker compose -f infra/docker-compose.dev.yml up -d`. The app and the migrate
  script run on the host, so `.env`'s `DATABASE_URL` / `REDIS_URL` must point at
  `localhost` (not the in-Docker hostnames `postgres` / `redis`, which only
  resolve inside the full `docker-compose.yml` network).
- Migrations applied (`pnpm --filter @patchpilot/db migrate` → `[db] migrations applied.`).
- API and web dev servers running (`pnpm -w dev` or per-app).

## Steps

1. **Log in.** Open the web app → you should be bounced to Microsoft, not
   auto-injected as the demo engineer. Confirm no DEMO_MODE banner. Sign in with
   an MSP engineer account.

2. **Discover tenants.** Settings → **Tenants** → click **Discover tenants**.
   - Expect: your home tenant row with the **MSP** badge and **consented** status,
     plus any GDAP customer tenants (consent status reflecting each relationship).
   - The success message shows the discovered count and licensing-refresh result.
   - Verify the **Licenses** column populates for consented tenants (Intune /
     Defender / etc. as detected).

3. **Sync data.** On a consented tenant row, click **Sync data**.
   - Expect a success message: `N device(s), M CVE(s)`.
   - Re-clicking re-runs a full device snapshot + CVE upsert (idempotent;
     `detectedAt` SLA clock and engineer-set `status` are preserved on existing
     CVEs).

4. **Verify pages populate.**
   - **Devices** page: hostnames, OS, compliance, last-seen, and per-device
     vulnerability counts appear for the synced tenant.
   - **Vulnerabilities** page: CVE rows with severity, CVSS, affected-device
     count, software, and winget-remediable flag.

## Critical field-shape check (needs live confirmation)

The one mapping verified only against assumptions is the Defender source
`/api/vulnerabilities/machinesVulnerabilities`. In `apps/api/src/graph/sync.ts`
the aggregation reads these fields per row:

| Code expects | Used for |
|---|---|
| `cveId` | group key → `vulnerabilities.cveId` |
| `machineId` | distinct affected-machine set + per-device count attribution |
| `productName` | software label (with `productVendor`) |
| `productVendor` | software label vendor prefix |
| `severity` | highest-severity rollup per CVE |
| `firstSeenTimestamp` | earliest across machines → `vulnerabilities.detectedAt` (Defender's org-wide "First detected", the SLA clock) |

If `machinesVulnerabilities` does **not** carry `firstSeenTimestamp`, the
"Detected" column falls back to sync time and won't match Defender's portal. The
field is on the export-assessment source
`GET /api/machines/SoftwareVulnerabilitiesByMachine`; switch the source endpoint
there (its analogues are `softwareName`/`softwareVendor`/`vulnerabilitySeverityLevel`)
if a live sync shows the timestamp is absent on `machinesVulnerabilities`.

**How to confirm:** with the engineer logged in, watch the API logs during a
Sync data run, or capture one raw page from the audit trail, and confirm the
live JSON uses exactly these property names. If Defender returns different casing
or names (e.g. `cveId` vs `id`, `productName` vs `name`), adjust the
`MachineVulnerability` type + `aggregateVulnerabilities`/`mapSeverity` mappers in
`apps/api/src/graph/sync.ts` accordingly. Everything else (Intune devices,
tenant discovery, licensing) uses documented Graph shapes.

## Expected failure modes (not bugs)

- **Unlicensed Defender:** `/machines` and CVE reads are best-effort; a tenant
  without Defender yields 0 CVEs and devices without `defenderMachineId` — by
  design (graceful licensing degradation).
- **Non-consented tenant:** Sync data button is disabled until consent is granted
  via Setup → App Registration.
- **DEMO_MODE accidentally on:** every sync route returns `409 demo_mode`; the
  buttons are disabled with a tooltip. This is the production safety gate.
