CREATE TYPE "public"."remediation_attribution" AS ENUM('job', 'manual', 'unattributed');--> statement-breakpoint
CREATE TYPE "public"."remediation_closure" AS ENUM('cleared', 'reclassified');--> statement-breakpoint
ALTER TABLE "remediation_events" ALTER COLUMN "remediated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "device_hostname" text;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "engineer" text;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "channel" "channel";--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "attribution" "remediation_attribution" DEFAULT 'unattributed' NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "fix_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "fix_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "contributing_jobs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_events" ADD COLUMN "closure" "remediation_closure" DEFAULT 'cleared' NOT NULL;--> statement-breakpoint
CREATE INDEX "remediation_events_tenant_cve_idx" ON "remediation_events" USING btree ("tenant_id","cve_id");--> statement-breakpoint
CREATE INDEX "remediation_events_tenant_device_idx" ON "remediation_events" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "remediation_events_engineer_idx" ON "remediation_events" USING btree ("engineer");