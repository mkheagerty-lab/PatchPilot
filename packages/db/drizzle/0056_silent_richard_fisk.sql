CREATE TYPE "public"."theme" AS ENUM('light', 'dark');--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "theme" "theme" DEFAULT 'light' NOT NULL;