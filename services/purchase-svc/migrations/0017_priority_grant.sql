CREATE TABLE "priority_grant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"fraud_case_id" uuid NOT NULL,
	"cancelled_ticket_id" uuid NOT NULL,
	"grant_kind" text NOT NULL,
	"seat_id" uuid NOT NULL,
	"tier_id" text NOT NULL,
	"price" integer NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"active_order_id" uuid,
	"used_order_id" uuid,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "priority_grant_kind_check" CHECK ("priority_grant"."grant_kind" in ('SAME_SEAT', 'SAME_TIER')),
	CONSTRAINT "priority_grant_status_check" CHECK ("priority_grant"."status" in ('OFFERED', 'USED', 'EXPIRED', 'WITHDRAWN')),
	CONSTRAINT "priority_grant_price_check" CHECK ("priority_grant"."price" >= 0),
	CONSTRAINT "priority_grant_version_check" CHECK ("priority_grant"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "priority_grant_cancelled_ticket_key" ON "priority_grant" USING btree ("cancelled_ticket_id");--> statement-breakpoint
CREATE INDEX "priority_grant_account_event_idx" ON "priority_grant" USING btree ("account_id","event_id");