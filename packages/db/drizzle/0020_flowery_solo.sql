CREATE TABLE "chocolatey_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" text NOT NULL,
	"name" text NOT NULL,
	"publisher" text NOT NULL,
	"latest_version" text,
	"software_title" text,
	"source" text,
	"last_refreshed_at" timestamp with time zone,
	CONSTRAINT "chocolatey_catalog_package_id_unique" UNIQUE("package_id")
);
--> statement-breakpoint
CREATE TABLE "chocolatey_catalog_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"software_title" text NOT NULL,
	"package_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_software" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"defender_machine_id" text NOT NULL,
	"software_id" text NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"version" text,
	"disk_paths" jsonb,
	"registry_paths" jsonb
);
--> statement-breakpoint
CREATE TABLE "software_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"software_id" text NOT NULL,
	"name" text NOT NULL,
	"vendor" text,
	"weakness_count" integer DEFAULT 0 NOT NULL,
	"exposed_machines_count" integer DEFAULT 0 NOT NULL,
	"installed_machines_count" integer DEFAULT 0 NOT NULL,
	"public_exploit" boolean DEFAULT false NOT NULL,
	"context" text,
	"matched_package_id" text,
	"matched_package_source" text,
	"matched_latest_version" text,
	"detected_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "chocolatey_override_tenant_idx" ON "chocolatey_catalog_override" USING btree ("tenant_id","software_title");--> statement-breakpoint
CREATE INDEX "device_software_tenant_machine_idx" ON "device_software" USING btree ("tenant_id","defender_machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_software_unique_idx" ON "device_software" USING btree ("tenant_id","defender_machine_id","software_id");--> statement-breakpoint
CREATE INDEX "software_inventory_tenant_idx" ON "software_inventory" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "software_inventory_tenant_software_idx" ON "software_inventory" USING btree ("tenant_id","software_id");