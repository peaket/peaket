-- F-06-3 승인된 예외 환불(purchase-svc). 정본: docs/features/transfer-refund.md §3.2·§7.2, docs/data.md approval_refund·order_cancellation.
-- 번호 0040: 이 저장소의 최대는 0038이며 0038·0039는 다른 동결 가지(F-07-2) 몫이다(계획 §8).
CREATE TABLE IF NOT EXISTS "approval_refund" (
  "approval_id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "amount" bigint NOT NULL,
  "refund_amount" bigint NOT NULL,
  "cancellation_id" uuid NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "approval_refund_kind_check" CHECK ("approval_refund"."kind" in ('SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'MINOR_CONTRACT_CANCEL')),
  CONSTRAINT "approval_refund_status_check" CHECK ("approval_refund"."status" in ('REQUESTED', 'REFUND_PENDING', 'REFUNDED')),
  CONSTRAINT "approval_refund_amount_check" CHECK ("approval_refund"."amount" >= 0 and "approval_refund"."refund_amount" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_refund_order_idx" ON "approval_refund" ("order_id", "created_at");
