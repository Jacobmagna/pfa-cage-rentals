CREATE TYPE "public"."resource_type" AS ENUM('cage', 'bullpen', 'weight_room');--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "resource_type" NOT NULL,
	"sort_order" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "resources_name_unique" UNIQUE("name")
);
