CREATE TABLE "program_schedule_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"scheduled_coach_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "program_schedule_blocks" ADD CONSTRAINT "program_schedule_blocks_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_blocks" ADD CONSTRAINT "program_schedule_blocks_scheduled_coach_id_users_id_fk" FOREIGN KEY ("scheduled_coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_blocks" ADD CONSTRAINT "program_schedule_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_schedule_blocks_program_start_idx" ON "program_schedule_blocks" USING btree ("program_id","start_at");--> statement-breakpoint
CREATE INDEX "program_schedule_blocks_coach_start_idx" ON "program_schedule_blocks" USING btree ("scheduled_coach_id","start_at");--> statement-breakpoint

-- Raw-SQL CHECK constraint (Drizzle Kit can't generate CHECK). Same
-- approach as hour_logs / sessions_billing's start<end CHECK.
-- Reject backwards or zero-duration program schedule blocks.
ALTER TABLE "program_schedule_blocks" ADD CONSTRAINT "program_schedule_blocks_start_before_end" CHECK ("start_at" < "end_at");