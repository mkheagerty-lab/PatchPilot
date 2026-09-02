CREATE TYPE "public"."device_exclusion_justification" AS ENUM('inactive-device', 'duplicate-device', 'device-does-not-exist', 'out-of-scope', 'other');--> statement-breakpoint
CREATE TABLE "device_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"managed_device_id" text NOT NULL,
	"device_hostname" text NOT NULL,
	"justification" "device_exclusion_justification" NOT NULL,
	"notes" text,
	"expires_at" timestamp with time zone,
	"status" "exception_status" DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "device_exclusions_tenant_idx" ON "device_exclusions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "device_exclusions_tenant_device_idx" ON "device_exclusions" USING btree ("tenant_id","managed_device_id");