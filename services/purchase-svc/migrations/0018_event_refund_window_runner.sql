CREATE TABLE "event_refund_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"pg" text NOT NULL,
	"amount" integer NOT NULL,
	"outcome" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_refund_attempt_pg_check" CHECK ("event_refund_attempt"."pg" in ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "event_refund_attempt_outcome_check" CHECK ("event_refund_attempt"."outcome" in ('SUCCESS', 'FAILURE', 'REJECT', 'UNKNOWN')),
	CONSTRAINT "event_refund_attempt_amount_check" CHECK ("event_refund_attempt"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "event_refund_item" DROP CONSTRAINT "event_refund_item_status_check";--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD COLUMN "postponed_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD COLUMN "refund_window_closes_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "event_refund_attempt_pg_time_idx" ON "event_refund_attempt" USING btree ("pg","attempted_at");--> statement-breakpoint
CREATE INDEX "event_refund_item_due_idx" ON "event_refund_item" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD CONSTRAINT "event_cancellation_window_check" CHECK ("event_cancellation_request"."refund_window_closes_at" is null or "event_cancellation_request"."postponed_to" is null or "event_cancellation_request"."refund_window_closes_at" <= "event_cancellation_request"."postponed_to");--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD CONSTRAINT "event_refund_item_status_check" CHECK ("event_refund_item"."status" in ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN', 'NOT_APPLIED'));