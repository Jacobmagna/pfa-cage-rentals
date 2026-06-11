ALTER TABLE "program_schedule_blocks" ALTER COLUMN "scheduled_coach_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "program_schedule_series" ALTER COLUMN "scheduled_coach_id" DROP NOT NULL;