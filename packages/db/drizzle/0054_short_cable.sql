CREATE TABLE "update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_version" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"triggered_by" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"output" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "update_runs_status_idx" ON "update_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "update_runs_scheduled_idx" ON "update_runs" USING btree ("scheduled_at");