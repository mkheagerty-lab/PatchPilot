CREATE TYPE "public"."user_role" AS ENUM('admin', 'technician', 'reader');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
ALTER TABLE "engineers" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "engineers" ALTER COLUMN "role" SET DATA TYPE "public"."user_role" USING (CASE "role"::text
  WHEN 'admin' THEN 'admin'
  WHEN 'lead' THEN 'admin'
  ELSE 'technician' END)::"public"."user_role";--> statement-breakpoint
ALTER TABLE "engineers" ALTER COLUMN "role" SET DEFAULT 'technician';--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "status" "public"."user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "invited_by" text;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DROP TYPE "public"."engineer_role";
