ALTER TABLE "program_rate_overrides" ALTER COLUMN "rate_per_30_min_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "program_rate_overrides" ADD COLUMN "pay_mode" "coach_pay_mode" DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "program_rate_overrides" ADD COLUMN "per_session_rate_cents" integer;