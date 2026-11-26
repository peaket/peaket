ALTER TABLE "order_cancellation" ADD COLUMN "refund_account_notice_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_account_notice_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "compensation" ADD COLUMN "account_notice_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "compensation" ADD COLUMN "account_notice_next_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_cancellation_account_notice_due_idx" ON "order_cancellation" USING btree ("refund_account_notice_next_at") WHERE "order_cancellation"."status" = 'REFUND_PENDING' and "order_cancellation"."refund_account_required_at" is not null;--> statement-breakpoint
CREATE INDEX "compensation_account_notice_due_idx" ON "compensation" USING btree ("account_notice_next_at") WHERE "compensation"."status" = 'ACCOUNT_PENDING';