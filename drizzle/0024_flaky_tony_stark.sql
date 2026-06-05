CREATE TYPE "public"."recurrence_frequency" AS ENUM('weekly', 'monthly');--> statement-breakpoint
ALTER TABLE "program_schedule_series" ADD COLUMN "frequency" "recurrence_frequency" DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "program_schedule_series" ADD COLUMN "recurrence_interval" integer DEFAULT 1 NOT NULL;