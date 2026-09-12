CREATE TYPE "public"."host_reboot_status" AS ENUM('queued', 'issuing', 'issued', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "host_reboot_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "host_reboot_status" DEFAULT 'queued' NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"output" text
);
--> statement-breakpoint
CREATE TABLE "host_status" (
	"id" text PRIMARY KEY NOT NULL,
	"reboot_required" boolean NOT NULL,
	"reboot_required_packages" text,
	"last_unattended_upgrade_at" timestamp with time zone,
	"docker_live_restore_active" boolean,
	"sampled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "host_reboot_requests_status_idx" ON "host_reboot_requests" USING btree ("status");