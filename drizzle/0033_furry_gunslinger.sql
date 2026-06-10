CREATE TYPE "public"."hour_log_status" AS ENUM('posted', 'held');--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "status" "hour_log_status" DEFAULT 'posted' NOT NULL;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "held_reason" text;--> statement-breakpoint
CREATE INDEX "hour_logs_status_idx" ON "hour_logs" USING btree ("status");