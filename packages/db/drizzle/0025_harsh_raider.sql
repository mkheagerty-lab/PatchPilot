CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'system', 'schedule', 'worker');--> statement-breakpoint
CREATE TYPE "public"."audit_category" AS ENUM('action', 'api_call');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'partial', 'skipped');--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "category" "audit_category" DEFAULT 'api_call' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_type" "audit_actor_type" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "action" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "resource_type" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "resource_label" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "outcome" "audit_outcome";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "detail" text;--> statement-breakpoint
CREATE INDEX "audit_category_at_idx" ON "audit_log" USING btree ("category","at");--> statement-breakpoint
CREATE INDEX "audit_tenant_at_idx" ON "audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_engineer_idx" ON "audit_log" USING btree ("engineer");--> statement-breakpoint
CREATE INDEX "audit_resource_idx" ON "audit_log" USING btree ("resource_type","resource_id");--> statement-breakpoint
-- Everything below is hand-written: drizzle-kit only emits DDL, and the new
-- columns' defaults are correct for new rows but wrong for the history.
--
-- Backfill 1 (load-bearing). Only graphGet/graphWrite/graphUpload build an
-- endpoint as `${host}:${path}` with host in (graph, defender); every other
-- historical row came from a hand-written audit() call and is a domain action.
-- Keep this rule in lockstep with inferCategory() in packages/graph/src/audit.ts.
UPDATE "audit_log" SET "category" = 'action'
 WHERE "endpoint" NOT LIKE 'graph:%' AND "endpoint" NOT LIKE 'defender:%';--> statement-breakpoint
-- Backfill 2 (load-bearing). Same rule deriveAuditOutcome() applies at read time,
-- materialised once so the Outcome filter can be a plain indexed predicate.
UPDATE "audit_log" SET "outcome" = CASE WHEN "response_status" >= 400
   THEN 'failure'::"public"."audit_outcome" ELSE 'success'::"public"."audit_outcome" END
 WHERE "response_status" IS NOT NULL;--> statement-breakpoint
-- Backfill 3 (cosmetic). Map the five pseudo-endpoints that predate the `action`
-- column onto their canonical names, so historical rows aren't blank in the UI.
UPDATE "audit_log" SET "action" = 'remediation:manual-record', "resource_type" = 'manual-remediation'
 WHERE "endpoint" = 'manual-remediation:record';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'exception:create', "resource_type" = 'exception'
 WHERE "endpoint" = 'recommendation-exception:create';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'script:upload', "resource_type" = 'script'
 WHERE "endpoint" = 'script-catalog:upload';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'catalog:override-create', "resource_type" = 'catalog-override'
 WHERE "endpoint" = 'catalog:override';--> statement-breakpoint
UPDATE "audit_log" SET "action" = 'catalog:refresh', "resource_type" = 'catalog'
 WHERE "endpoint" = 'winget-mirror:source.msix';