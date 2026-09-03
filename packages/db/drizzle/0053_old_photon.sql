CREATE TYPE "public"."domain_status" AS ENUM('pending', 'active');--> statement-breakpoint
CREATE TYPE "public"."domain_type" AS ENUM('subdomain', 'custom');--> statement-breakpoint
CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hostname" text NOT NULL,
	"type" "domain_type" NOT NULL,
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"cname_target" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_hostname_idx" ON "custom_domains" USING btree ("hostname");