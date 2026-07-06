CREATE TABLE "travel_sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "travel_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_sessions" ADD CONSTRAINT "travel_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;