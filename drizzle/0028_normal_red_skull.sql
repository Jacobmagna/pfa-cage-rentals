CREATE TYPE "public"."program_block_coach_flag_kind" AS ENUM('cancelled', 'no_show');--> statement-breakpoint
CREATE TABLE "program_block_coach_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"block_id" text NOT NULL,
	"coach_id" text NOT NULL,
	"kind" "program_block_coach_flag_kind" NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_at" timestamp,
	"reviewed_by" text
);
--> statement-breakpoint
ALTER TABLE "program_block_coach_flags" ADD CONSTRAINT "program_block_coach_flags_block_id_program_schedule_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."program_schedule_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_block_coach_flags" ADD CONSTRAINT "program_block_coach_flags_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_block_coach_flags" ADD CONSTRAINT "program_block_coach_flags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_block_coach_flags" ADD CONSTRAINT "program_block_coach_flags_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "program_block_coach_flags_block_coach_kind_idx" ON "program_block_coach_flags" USING btree ("block_id","coach_id","kind");--> statement-breakpoint
CREATE INDEX "program_block_coach_flags_kind_reviewed_idx" ON "program_block_coach_flags" USING btree ("kind","reviewed_at");