-- Remove any pre-existing exact-duplicate hour-logs (true double-logs from
-- prior double-confirms/double-taps) before adding the unique index, keeping
-- the earliest row (lowest id) per (coach, program, start, end) group. Without
-- this the CREATE UNIQUE INDEX below would fail if duplicates already exist.
DELETE FROM "hour_logs" a USING "hour_logs" b
WHERE a.id > b.id
  AND a.coach_id = b.coach_id
  AND a.program_id = b.program_id
  AND a.start_at = b.start_at
  AND a.end_at = b.end_at;
--> statement-breakpoint
CREATE UNIQUE INDEX "hour_logs_coach_program_start_end_unique" ON "hour_logs" USING btree ("coach_id","program_id","start_at","end_at");