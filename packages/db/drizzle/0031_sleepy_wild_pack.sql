CREATE TYPE "public"."remediation_event_kind" AS ENUM('vulnerability', 'recommendation');--> statement-breakpoint
CREATE TABLE "remediation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" "remediation_event_kind" NOT NULL,
	"cve_id" text,
	"recommendation_id" text,
	"software" text,
	"severity" "severity" NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"remediated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "remediation_events_tenant_remediated_idx" ON "remediation_events" USING btree ("tenant_id","remediated_at");--> statement-breakpoint
CREATE INDEX "remediation_events_tenant_severity_idx" ON "remediation_events" USING btree ("tenant_id","severity");