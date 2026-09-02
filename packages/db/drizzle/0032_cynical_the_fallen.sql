CREATE TYPE "public"."script_type" AS ENUM('powershell', 'cmd', 'bash');--> statement-breakpoint
ALTER TABLE "script_catalog" ADD COLUMN "script_type" "script_type" DEFAULT 'powershell' NOT NULL;--> statement-breakpoint
ALTER TABLE "script_catalog" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "script_catalog_tenant_idx" ON "script_catalog" USING btree ("tenant_id");