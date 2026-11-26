-- F-06-3 지급 대상 지문·15시 만료(payment-svc). 정본: docs/features/settlement.md §5.1, docs/data.md payout_batch·payout_approval.
-- 번호 0040: 이 저장소의 payment-svc 최대 번호는 0033이며, 다른 동결 가지가 0034~0039를 먼저 잡을 수 있어 겹치지 않게 0040으로 둔다(계획 §8).
ALTER TABLE "payout_batch" ADD COLUMN IF NOT EXISTS "payee_digest" text;
--> statement-breakpoint
ALTER TABLE "payout_batch" DROP CONSTRAINT IF EXISTS "payout_batch_status_check";
--> statement-breakpoint
ALTER TABLE "payout_batch" ADD CONSTRAINT "payout_batch_status_check" CHECK ("payout_batch"."status" in ('PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'PARTIAL_FAILED', 'EXPIRED'));
--> statement-breakpoint
ALTER TABLE "payout_batch" ADD CONSTRAINT "payout_batch_payee_digest_check" CHECK ("payout_batch"."payee_digest" is null or "payout_batch"."payee_digest" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "payout_batch_audit" ADD COLUMN IF NOT EXISTS "payee_digest" text;
--> statement-breakpoint
ALTER TABLE "payout_batch_audit" DROP CONSTRAINT IF EXISTS "payout_batch_audit_event_check";
--> statement-breakpoint
ALTER TABLE "payout_batch_audit" ADD CONSTRAINT "payout_batch_audit_event_check" CHECK ("payout_batch_audit"."event" in ('APPROVED', 'REJECTED', 'EXPIRED'));
