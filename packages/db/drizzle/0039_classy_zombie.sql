CREATE TYPE "public"."intune_app_type" AS ENUM('win32-lob', 'winget');--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE 'winget-app';--> statement-breakpoint
CREATE TABLE "intune_app_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"app_type" "intune_app_type" NOT NULL,
	"source" text NOT NULL,
	"package_id" text NOT NULL,
	"intune_app_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intune_app_deployments_tenant_source_package_idx" ON "intune_app_deployments" USING btree ("tenant_id","source","package_id");