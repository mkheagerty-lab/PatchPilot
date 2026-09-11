CREATE TYPE "public"."server_control_action" AS ENUM('restart-container', 'restart-stack');--> statement-breakpoint
CREATE TABLE "server_control_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" "server_control_action" NOT NULL,
	"target" text,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"output" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "server_control_requests_status_idx" ON "server_control_requests" USING btree ("status");