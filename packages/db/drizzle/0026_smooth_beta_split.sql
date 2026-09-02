-- Data-only migration: no DDL, so drizzle-kit generates nothing for it and the
-- 0026 snapshot is a byte-for-byte re-issue of 0025.
--
-- Fix 1 (load-bearing). 0025's category backfill matched only `graph:%` and
-- `defender:%`, but GraphHost has a third member — `beta` — and graphGet builds
-- its endpoint as `${host}:${path}` for all three. Every beta read ever made
-- was therefore filed as a domain action and shows up in the Actions view as a
-- raw `beta:/deviceManagement/managedDevices?$select=...` line. Keep this list
-- in lockstep with API_CALL_HOSTS in packages/graph/src/audit.ts, which
-- client.ts now asserts against at compile time.
UPDATE "audit_log" SET "category" = 'api_call'
 WHERE "action" IS NULL AND "endpoint" LIKE 'beta:%';--> statement-breakpoint
-- Fix 2 (cosmetic). Remediation dispatches predating the `action` column stored
-- the CHANNEL_SPECS endpoint template as their endpoint, so the Action column
-- falls back to rendering that raw template. These rows are genuine domain
-- actions — see the audit() calls in apps/api/src/routes/jobs.ts,
-- missing-kbs.ts and software-inventory.ts, which all pass
-- `endpoint: CHANNEL_SPECS[channel].endpointTemplate`. Name them.
UPDATE "audit_log" SET "action" = 'remediation:dispatch', "resource_type" = 'job'
 WHERE "action" IS NULL AND "endpoint" LIKE 'POST /%';--> statement-breakpoint
-- Fix 3 (cosmetic). The write-posture toggle audits the literal REST path.
UPDATE "audit_log" SET "action" = 'tenant:set-write-posture', "resource_type" = 'tenant'
 WHERE "action" IS NULL AND "method" = 'PATCH' AND "endpoint" LIKE '/api/tenants/%';--> statement-breakpoint
-- Fix 4 (cosmetic). Completes the pseudo-endpoint mapping started in 0025 —
-- these two had no historical rows when 0025 was written.
UPDATE "audit_log" SET "action" = 'exception:cancel', "resource_type" = 'exception'
 WHERE "endpoint" = 'recommendation-exception:cancel';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'chocolatey-catalog:refresh', "resource_type" = 'catalog'
 WHERE "endpoint" = 'chocolatey-mirror:source.odata';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'schedule:create', "resource_type" = 'schedule'
 WHERE "method" = 'POST' AND "endpoint" = '/api/schedules';
