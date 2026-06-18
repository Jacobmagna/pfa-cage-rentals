ALTER TYPE "public"."hour_log_status" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "decision_reason" text;