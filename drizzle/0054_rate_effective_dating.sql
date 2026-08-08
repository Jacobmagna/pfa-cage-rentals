CREATE TYPE "public"."rate_source_kind" AS ENUM('override', 'program_default', 'none');--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "rate_source_kind" "rate_source_kind";--> statement-breakpoint
ALTER TABLE "program_rate_overrides" ADD COLUMN "effective_from" timestamp;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "default_rate_effective_from" timestamp;