-- 좌석 v0 표(docs/features/seat-hold.md §14). drizzle-kit generate가 만든 모양을 검토해 커밋한다(ADR-0037 결정 6)
CREATE TABLE "v0_hold" (
	"hold_id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seat_ids" text[] NOT NULL,
	"status" text NOT NULL,
	"extended" boolean DEFAULT false NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "v0_hold_status_check" CHECK ("v0_hold"."status" in ('HELD', 'RELEASED', 'EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "v0_quota" (
	"event_id" text NOT NULL,
	"account_id" text NOT NULL,
	"held" integer NOT NULL,
	CONSTRAINT "v0_quota_event_id_account_id_pk" PRIMARY KEY("event_id","account_id"),
	CONSTRAINT "v0_quota_held_check" CHECK ("v0_quota"."held" >= 0)
);
--> statement-breakpoint
CREATE TABLE "v0_seat" (
	"event_id" text NOT NULL,
	"seat_id" text NOT NULL,
	"section" text NOT NULL,
	"row_label" text NOT NULL,
	"seat_number" integer NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"grade" text NOT NULL,
	"status" text NOT NULL,
	"hold_id" uuid,
	CONSTRAINT "v0_seat_event_id_seat_id_pk" PRIMARY KEY("event_id","seat_id"),
	CONSTRAINT "v0_seat_status_check" CHECK ("v0_seat"."status" in ('AVAILABLE', 'HELD', 'SOLD')),
	CONSTRAINT "v0_seat_hold_check" CHECK (("v0_seat"."status" = 'HELD') = ("v0_seat"."hold_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "v0_seat_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"per_person_limit" integer NOT NULL,
	"hold_ttl_ms" integer NOT NULL,
	"extend_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "v0_hold_due_idx" ON "v0_hold" USING btree ("expires_at") WHERE "v0_hold"."status" = 'HELD';