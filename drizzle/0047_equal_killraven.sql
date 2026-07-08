CREATE TABLE "travel_verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "travel_verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "travel_sessions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "travel_sessions" ADD COLUMN "guardian_id" text;--> statement-breakpoint
ALTER TABLE "travel_sessions" ADD CONSTRAINT "travel_sessions_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_sessions" ADD CONSTRAINT "travel_sessions_subject_ck" CHECK (num_nonnulls("travel_sessions"."user_id", "travel_sessions"."guardian_id") = 1);