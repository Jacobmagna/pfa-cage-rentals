CREATE TABLE "org_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"pfa_venmo_handle" text,
	"pfa_zelle_contact" text,
	"pfa_display_name" text DEFAULT 'PFA Sports' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "venmo_handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "zelle_contact" text;--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed the singleton row so getOrgSettings() never returns null.
-- ON CONFLICT DO NOTHING makes this safe to re-run.
INSERT INTO "org_settings" ("id", "pfa_display_name") VALUES ('default', 'PFA Sports') ON CONFLICT ("id") DO NOTHING;