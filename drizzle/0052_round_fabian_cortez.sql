ALTER TABLE "programs" ADD COLUMN "pay_mode" "coach_pay_mode" DEFAULT 'hourly' NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "default_per_session_rate_cents" integer;