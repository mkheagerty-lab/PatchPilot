CREATE TABLE "posture_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"day" date NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"devices" integer NOT NULL,
	"devices_compliant" integer NOT NULL,
	"devices_noncompliant" integer NOT NULL,
	"devices_unknown" integer NOT NULL,
	"open_findings" integer NOT NULL,
	"critical" integer NOT NULL,
	"high" integer NOT NULL,
	"medium" integer NOT NULL,
	"low" integer NOT NULL,
	"sla_breached" integer NOT NULL,
	"sla_due_soon" integer NOT NULL,
	"sla_ok" integer NOT NULL,
	"sla_thresholds" jsonb NOT NULL,
	"software_covered" integer NOT NULL,
	"software_uncovered" integer NOT NULL,
	"software_os" integer NOT NULL,
	"jobs_succeeded" integer NOT NULL,
	"jobs_failed" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "posture_snapshots_tenant_day_idx" ON "posture_snapshots" USING btree ("tenant_id","day");--> statement-breakpoint
CREATE INDEX "posture_snapshots_day_idx" ON "posture_snapshots" USING btree ("day");