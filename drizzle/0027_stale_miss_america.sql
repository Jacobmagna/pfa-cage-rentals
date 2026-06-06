ALTER TABLE "hour_logs" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD CONSTRAINT "hour_logs_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;