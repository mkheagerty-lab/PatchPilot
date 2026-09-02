CREATE TYPE "public"."channel" AS ENUM('live-response', 'intune-remediation', 'win32-app', 'expedited-quality-update');--> statement-breakpoint
CREATE TYPE "public"."compliance" AS ENUM('compliant', 'noncompliant', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('consented', 'pending', 'expired');--> statement-breakpoint
CREATE TYPE "public"."engineer_role" AS ENUM('engineer', 'lead', 'admin');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."vuln_status" AS ENUM('open', 'in-progress', 'remediated', 'dismissed');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"engineer" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"payload_hash" text,
	"response_status" integer,
	"latency_ms" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"managed_device_id" text NOT NULL,
	"defender_machine_id" text,
	"hostname" text NOT NULL,
	"os" text NOT NULL,
	"last_seen" timestamp with time zone,
	"compliance" "compliance" DEFAULT 'unknown' NOT NULL,
	"vulnerability_count" integer DEFAULT 0 NOT NULL,
	"owner" text
);
--> statement-breakpoint
CREATE TABLE "engineers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upn" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "engineer_role" DEFAULT 'engineer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engineers_upn_unique" UNIQUE("upn")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid,
	"cve_id" text,
	"channel" "channel" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"engineer" text NOT NULL,
	"exit_code" integer,
	"output" text,
	"queue_job_id" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"channel" "channel" NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"consent_status" "consent_status" DEFAULT 'pending' NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"licenses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_msp_tenant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "vulnerabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"cve_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" "severity" NOT NULL,
	"cvss" double precision,
	"affected_device_count" integer DEFAULT 0 NOT NULL,
	"software" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"winget_remediable" boolean DEFAULT false NOT NULL,
	"winget_package_id" text,
	"status" "vuln_status" DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "winget_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"publisher" text NOT NULL,
	"latest_version" text,
	"software_title" text,
	CONSTRAINT "winget_catalog_package_id_unique" UNIQUE("package_id")
);
--> statement-breakpoint
CREATE INDEX "audit_tenant_idx" ON "audit_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "devices_tenant_idx" ON "devices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "jobs_tenant_idx" ON "jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vulns_tenant_idx" ON "vulnerabilities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "vulns_severity_idx" ON "vulnerabilities" USING btree ("severity");