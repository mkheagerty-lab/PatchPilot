CREATE TABLE "quality_update_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kb_id" text NOT NULL,
	"catalog_item_id" text NOT NULL,
	"release_label" text NOT NULL,
	"days_until_forced_reboot" integer NOT NULL,
	"group_name" text NOT NULL,
	"group_id" text NOT NULL,
	"intune_profile_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "quality_update_campaigns_tenant_idx" ON "quality_update_campaigns" USING btree ("tenant_id");