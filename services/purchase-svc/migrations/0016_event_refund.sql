CREATE TABLE "event_cancellation_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"fault" text,
	"fan_notice_reason" text,
	"ruled_by" text,
	"confirmed_by" text,
	"target_orders" integer DEFAULT 0 NOT NULL,
	"refund_total" integer DEFAULT 0 NOT NULL,
	"compensation_targets" integer DEFAULT 0 NOT NULL,
	"compensation_total" integer DEFAULT 0 NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_cancellation_kind_check" CHECK ("event_cancellation_request"."kind" in ('CANCEL', 'POSTPONE')),
	CONSTRAINT "event_cancellation_status_check" CHECK ("event_cancellation_request"."status" in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED')),
	CONSTRAINT "event_cancellation_fault_check" CHECK ("event_cancellation_request"."fault" is null or "event_cancellation_request"."fault" in ('ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE')),
	CONSTRAINT "event_cancellation_amounts_check" CHECK ("event_cancellation_request"."target_orders" >= 0 and "event_cancellation_request"."refund_total" >= 0 and "event_cancellation_request"."compensation_targets" >= 0 and "event_cancellation_request"."compensation_total" >= 0),
	CONSTRAINT "event_cancellation_people_check" CHECK ("event_cancellation_request"."ruled_by" is null or "event_cancellation_request"."confirmed_by" is null or "event_cancellation_request"."ruled_by" <> "event_cancellation_request"."confirmed_by")
);
--> statement-breakpoint
CREATE TABLE "event_refund_item" (
	"request_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"cancellation_id" uuid NOT NULL,
	"pg" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_refund_item_pkey" PRIMARY KEY("request_id","ticket_id"),
	CONSTRAINT "event_refund_item_pg_check" CHECK ("event_refund_item"."pg" in ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "event_refund_item_status_check" CHECK ("event_refund_item"."status" in ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "event_refund_item_attempts_check" CHECK ("event_refund_item"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD CONSTRAINT "event_refund_item_request_id_event_cancellation_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."event_cancellation_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_cancellation_active_key" ON "event_cancellation_request" USING btree ("event_id") WHERE "event_cancellation_request"."status" in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW');--> statement-breakpoint
CREATE UNIQUE INDEX "event_refund_item_cancellation_key" ON "event_refund_item" USING btree ("cancellation_id");--> statement-breakpoint
CREATE INDEX "event_refund_item_status_idx" ON "event_refund_item" USING btree ("request_id","status");