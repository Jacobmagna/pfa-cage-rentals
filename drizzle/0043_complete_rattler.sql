ALTER TABLE "coach_rate_overrides" ADD COLUMN "group_rate_per_30_min_cents" integer;--> statement-breakpoint
ALTER TABLE "rate_defaults" ADD COLUMN "group_rate_per_30_min_cents" integer;--> statement-breakpoint
ALTER TABLE "sessions_billing" ADD COLUMN "is_group_session" boolean DEFAULT false NOT NULL;