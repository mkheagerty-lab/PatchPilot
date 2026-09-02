CREATE TYPE "public"."exception_justification" AS ENUM('third-party-control', 'alternate-mitigation', 'risk-accepted', 'planned-remediation', 'cve-no-patch', 'false-positive');--> statement-breakpoint
CREATE TYPE "public"."exception_scope" AS ENUM('global', 'device-group');--> statement-breakpoint
CREATE TYPE "public"."exception_status" AS ENUM('active', 'cancelled');--> statement-breakpoint
CREATE TABLE "recommendation_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"recommendation_id" text,
	"cve_id" text,
	"scope" "exception_scope" NOT NULL,
	"device_group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"justification" "exception_justification" NOT NULL,
	"notes" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "exception_status" DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "device_group_id" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "device_group_name" text;--> statement-breakpoint
CREATE INDEX "rec_exceptions_tenant_idx" ON "recommendation_exceptions" USING btree ("tenant_id");