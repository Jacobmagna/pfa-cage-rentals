CREATE TYPE "public"."coach_pay_mode" AS ENUM('hourly', 'per_session');--> statement-breakpoint
CREATE TYPE "public"."payment_direction" AS ENUM('coach_to_pfa', 'pfa_to_coach');--> statement-breakpoint
CREATE TABLE "coach_pay_settings" (
	"coach_id" text PRIMARY KEY NOT NULL,
	"pay_mode" "coach_pay_mode" DEFAULT 'hourly' NOT NULL,
	"per_session_rate_cents" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_payments" ADD COLUMN "direction" "payment_direction" DEFAULT 'coach_to_pfa' NOT NULL;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "per_session_rate_cents" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "coach_pay_settings" ADD CONSTRAINT "coach_pay_settings_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;