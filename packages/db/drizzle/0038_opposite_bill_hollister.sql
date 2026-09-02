CREATE TYPE "public"."report_status" AS ENUM('pending', 'rendering', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_type" text NOT NULL,
	"facts_version" integer DEFAULT 1 NOT NULL,
	"tenant_id" text,
	"tenant_name" text,
	"window_days" integer NOT NULL,
	"title" text NOT NULL,
	"engineer" text NOT NULL,
	"status" "report_status" DEFAULT 'pending' NOT NULL,
	"narrated" boolean DEFAULT false NOT NULL,
	"narration_skipped_reason" text,
	"fact_check_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pdf" "bytea",
	"pdf_bytes" integer,
	"pdf_sha256" text,
	"filename" text NOT NULL,
	"error" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reports_engineer_idx" ON "reports" USING btree ("engineer","requested_at");--> statement-breakpoint
CREATE INDEX "reports_expires_idx" ON "reports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "reports_tenant_idx" ON "reports" USING btree ("tenant_id","requested_at");