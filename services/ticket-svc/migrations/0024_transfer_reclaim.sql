-- F-06-3 양도 회수(ticket-svc). 정본: docs/features/transfer-refund.md §3.1·§7.2, docs/data.md transfer_reclaim.
-- 번호 0024: 이 저장소의 최대는 0023이며 0021~0023은 다른 동결 가지(F-05-12·F-05-11·F-04-13) 몫이다(계획 §8).
CREATE TABLE IF NOT EXISTS "transfer_reclaim" (
  "approval_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL REFERENCES "ticket"("id"),
  "expected_payer_account_id" uuid NOT NULL,
  "expected_holder_account_id" uuid NOT NULL,
  "previous_holder_account_id" uuid,
  "result" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("approval_id", "ticket_id"),
  CONSTRAINT "transfer_reclaim_result_check" CHECK ("transfer_reclaim"."result" in ('RECLAIMED', 'SKIPPED_ENTRY_STARTED', 'SKIPPED_ENTRY_RECORDED', 'SKIPPED_NOT_TRANSFERRED', 'SKIPPED_HOLDER_CHANGED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_reclaim_approval_uq" ON "transfer_reclaim" ("approval_id");
