CREATE TABLE "program_schedule_series" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"scheduled_coach_id" text NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"skip_dates" text[] DEFAULT '{}' NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "program_schedule_blocks" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "program_schedule_series" ADD CONSTRAINT "program_schedule_series_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_series" ADD CONSTRAINT "program_schedule_series_scheduled_coach_id_users_id_fk" FOREIGN KEY ("scheduled_coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_series" ADD CONSTRAINT "program_schedule_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_blocks" ADD CONSTRAINT "program_schedule_blocks_series_id_program_schedule_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."program_schedule_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_schedule_blocks_series_idx" ON "program_schedule_blocks" USING btree ("series_id");