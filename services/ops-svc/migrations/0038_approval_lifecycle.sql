-- F-06-3 승인 업무 수명주기·지급 대상 지문(ops-svc). 정본: docs/features/transfer-refund.md §7.2, docs/features/settlement.md §5.1,
-- docs/data.md approval_request·payout_approval. 번호 0038: 이 저장소 최대는 0034이고 0035~0037은 다른 동결 가지(F-04-12·F-04-13) 몫이다.
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "target_account_id" uuid;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "related_order_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "appeal_not_before" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "entry_starts_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_request" DROP CONSTRAINT IF EXISTS "approval_request_required_approvals_check";
--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_required_approvals_check" CHECK ("approval_request"."required_approvals" between 1 and 3);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_request_target_account_idx" ON "approval_request" ("kind", "target_account_id", "created_at");
--> statement-breakpoint
ALTER TABLE "payout_approval" ADD COLUMN IF NOT EXISTS "payee_digest" text;
--> statement-breakpoint
ALTER TABLE "payout_approval" DROP CONSTRAINT IF EXISTS "payout_approval_status_check";
--> statement-breakpoint
ALTER TABLE "payout_approval" ADD CONSTRAINT "payout_approval_status_check" CHECK ("payout_approval"."status" in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED', 'EXPIRED'));
--> statement-breakpoint
ALTER TABLE "payout_approval" ADD CONSTRAINT "payout_approval_payee_digest_check" CHECK ("payout_approval"."payee_digest" is null or "payout_approval"."payee_digest" ~ '^[0-9a-f]{64}$');
