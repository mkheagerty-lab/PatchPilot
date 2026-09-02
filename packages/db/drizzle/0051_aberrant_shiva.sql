CREATE TABLE "entitlement_device_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"managed_device_id" text NOT NULL,
	"device_hostname" text NOT NULL,
	"first_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_device_usage_tenant_device_idx" ON "entitlement_device_usage" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE INDEX "entitlement_device_usage_tenant_idx" ON "entitlement_device_usage" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_pairing_tokens_hash_idx" ON "onboarding_pairing_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "onboarding_pairing_tokens_expires_idx" ON "onboarding_pairing_tokens" USING btree ("expires_at");