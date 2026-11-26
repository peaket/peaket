-- F-06-4 일반 남용 예매 제한(F-06-4, PLAN §3). booking_restriction 표는 F-04-13 0037이 소유하므로 만들지 않는다.
-- 이 가지에는 표가 없으므로(0037이 없는 트리) 표가 있을 때만 사유 CHECK를 넓힌다. 0037 뒤에 적용되는 합성 트리에서만 바뀐다.
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "restriction_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "restriction_copy_pending" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "restriction_copy_next_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_request" ADD COLUMN IF NOT EXISTS "restriction_copy_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_request_booking_restriction_open_uq" ON "approval_request" ("kind", "target_ref")
  WHERE kind = 'BOOKING_RESTRICTION' AND status IN ('PENDING_APPROVAL', 'EXECUTING', 'FAILED');
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('booking_restriction') IS NOT NULL THEN
    ALTER TABLE "booking_restriction" DROP CONSTRAINT IF EXISTS "booking_restriction_reason_code_check";
    ALTER TABLE "booking_restriction" ADD CONSTRAINT "booking_restriction_reason_code_check" CHECK ("reason_code" IN ('FRAUD', 'ABUSE_CANCEL', 'ABUSE_TRANSFER', 'ABUSE_MULTI_ACCOUNT', 'ABUSE_RESALE'));
  END IF;
END $$;
