CREATE TABLE "remediation_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"job_id" uuid,
	"package_id" text NOT NULL,
	"software" text,
	"cve_id" text,
	"version_before" text,
	"version_after" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resync_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "remediation_verif_device_idx" ON "remediation_verifications" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "remediation_verif_at_idx" ON "remediation_verifications" USING btree ("verified_at");--> statement-breakpoint
CREATE INDEX "resync_due_idx" ON "resync_requests" USING btree ("due_at");