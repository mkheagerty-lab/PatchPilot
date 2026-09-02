CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"recommendation_name" text NOT NULL,
	"product_name" text NOT NULL,
	"vendor" text,
	"recommended_version" text,
	"severity" "severity" NOT NULL,
	"severity_score" double precision,
	"weakness_count" integer DEFAULT 0 NOT NULL,
	"exposed_machines_count" integer DEFAULT 0 NOT NULL,
	"total_machine_count" integer DEFAULT 0 NOT NULL,
	"public_exploit" boolean DEFAULT false NOT NULL,
	"remediation_type" text,
	"category" text,
	"recommendation_status" text,
	"detected_at" timestamp with time zone NOT NULL,
	"status" "vuln_status" DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recs_tenant_idx" ON "recommendations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "recs_severity_idx" ON "recommendations" USING btree ("severity");--> statement-breakpoint
CREATE UNIQUE INDEX "recs_tenant_rec_idx" ON "recommendations" USING btree ("tenant_id","recommendation_id");