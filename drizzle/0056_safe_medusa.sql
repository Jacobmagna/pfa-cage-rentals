CREATE TABLE "coach_stipend_earnings" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"period_key" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"amount_cents" integer NOT NULL,
	"earned_by_hour_log_id" text,
	"earned_at" timestamp DEFAULT now() NOT NULL,
	"voided_at" timestamp,
	"voided_by" text,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "coach_stipends" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_to" timestamp,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "stipend_covered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "stipend_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "coach_stipend_earnings" ADD CONSTRAINT "coach_stipend_earnings_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stipend_earnings" ADD CONSTRAINT "coach_stipend_earnings_earned_by_hour_log_id_hour_logs_id_fk" FOREIGN KEY ("earned_by_hour_log_id") REFERENCES "public"."hour_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stipend_earnings" ADD CONSTRAINT "coach_stipend_earnings_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stipends" ADD CONSTRAINT "coach_stipends_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stipends" ADD CONSTRAINT "coach_stipends_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coach_stipend_earnings_coach_period_idx" ON "coach_stipend_earnings" USING btree ("coach_id","period_key");--> statement-breakpoint
CREATE INDEX "coach_stipend_earnings_coach_start_idx" ON "coach_stipend_earnings" USING btree ("coach_id","period_start");--> statement-breakpoint
CREATE INDEX "coach_stipends_coach_effective_idx" ON "coach_stipends" USING btree ("coach_id","effective_from");