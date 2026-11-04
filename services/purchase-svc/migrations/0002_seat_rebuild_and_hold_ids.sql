CREATE TABLE "seat_rebuild" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"gen" integer DEFAULT 1 NOT NULL,
	"holder" text,
	"lease_until" timestamp with time zone,
	CONSTRAINT "seat_rebuild_gen_check" CHECK ("seat_rebuild"."gen" >= 1)
);
--> statement-breakpoint
ALTER TABLE "seat_hold" ADD COLUMN "hold_id" uuid;--> statement-breakpoint
ALTER TABLE "seat_hold" ADD COLUMN "purchase_session_id" text;