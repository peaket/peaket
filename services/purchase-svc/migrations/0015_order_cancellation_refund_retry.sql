ALTER TABLE "order_cancellation" DROP CONSTRAINT "order_cancellation_reason_check";--> statement-breakpoint
ALTER TABLE "order_cancellation" DROP CONSTRAINT "order_cancellation_status_check";--> statement-breakpoint
ALTER TABLE "order_cancellation" DROP CONSTRAINT "order_cancellation_amounts_check";--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "next_refund_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_last_error" text;--> statement-breakpoint
CREATE INDEX "order_cancellation_refund_due_idx" ON "order_cancellation" USING btree ("next_refund_at") WHERE "order_cancellation"."status" = 'REFUND_PENDING' and "order_cancellation"."refund_failed_at" is null;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_refund_attempts_check" CHECK ("order_cancellation"."refund_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_reason_check" CHECK ("order_cancellation"."reason" in ('USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', 'FRAUD'));--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_status_check" CHECK ("order_cancellation"."status" in ('REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED'));--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_amounts_check" CHECK ("order_cancellation"."days_before" >= 0 and "order_cancellation"."deduction_bp" between 0 and 10000 and "order_cancellation"."deduction_amount" >= 0 and "order_cancellation"."refund_amount" >= 0);