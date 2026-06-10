CREATE TABLE "sms_reminder_log" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"for_date" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"twilio_sid" text,
	"status" text NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_consent_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_prompt_answered_at" timestamp;--> statement-breakpoint
ALTER TABLE "sms_reminder_log" ADD CONSTRAINT "sms_reminder_log_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_reminder_log_coach_for_date_unique" ON "sms_reminder_log" USING btree ("coach_id","for_date");