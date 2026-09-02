CREATE TABLE "winget_catalog_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"software_title" text NOT NULL,
	"package_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "winget_override_tenant_idx" ON "winget_catalog_override" USING btree ("tenant_id","software_title");