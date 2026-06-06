CREATE TABLE "program_schedule_block_coaches" (
	"block_id" text NOT NULL,
	"coach_id" text NOT NULL,
	CONSTRAINT "program_schedule_block_coaches_block_id_coach_id_pk" PRIMARY KEY("block_id","coach_id")
);
--> statement-breakpoint
CREATE TABLE "program_schedule_series_coaches" (
	"series_id" text NOT NULL,
	"coach_id" text NOT NULL,
	CONSTRAINT "program_schedule_series_coaches_series_id_coach_id_pk" PRIMARY KEY("series_id","coach_id")
);
--> statement-breakpoint
ALTER TABLE "program_schedule_block_coaches" ADD CONSTRAINT "program_schedule_block_coaches_block_id_program_schedule_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."program_schedule_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_block_coaches" ADD CONSTRAINT "program_schedule_block_coaches_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_series_coaches" ADD CONSTRAINT "program_schedule_series_coaches_series_id_program_schedule_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."program_schedule_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_schedule_series_coaches" ADD CONSTRAINT "program_schedule_series_coaches_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_schedule_block_coaches_coach_idx" ON "program_schedule_block_coaches" USING btree ("coach_id");--> statement-breakpoint
CREATE INDEX "program_schedule_series_coaches_coach_idx" ON "program_schedule_series_coaches" USING btree ("coach_id");--> statement-breakpoint
INSERT INTO "program_schedule_block_coaches" ("block_id", "coach_id")
SELECT "id", "scheduled_coach_id" FROM "program_schedule_blocks"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "program_schedule_series_coaches" ("series_id", "coach_id")
SELECT "id", "scheduled_coach_id" FROM "program_schedule_series"
ON CONFLICT DO NOTHING;