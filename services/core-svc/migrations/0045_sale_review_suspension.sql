-- BAT-620 LCH-090: 판매 중지·재개(ADR-0123) core 트랜잭션.
-- 1) production에 판매 중지 시각·사유 코드·사유·승인 업무 ID·중지 때 판매 중이던 회차 목록을 더한다.
-- 2) 다섯 칸은 sale_review = 'SUSPENDED'일 때만 있다. 재개는 마지막 승인본(APPROVED)으로 돌아가며 모두 지운다.
-- 3) 사유 코드는 ADR-0123 결정 2의 네 가지이고, 사유는 1~1,000자다. 다시 열 회차 목록은 JSON 배열이다.
-- 4) 관제 역할(core_ops)만 이 칸을 쓴다. 파트너·팬 역할에는 열지 않는다(0012·0034의 권한을 넓히지 않는다).
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "suspension_reason_code" text;
--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "suspension_reason" text;
--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "suspension_approval_id" text;
--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "suspension_open_event_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_suspension_state_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_suspension_state_check" CHECK (
  ("sale_review" = 'SUSPENDED')
  OR ("suspended_at" IS NULL AND "suspension_reason_code" IS NULL AND "suspension_reason" IS NULL
      AND "suspension_approval_id" IS NULL AND "suspension_open_event_ids" IS NULL));
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_suspension_reason_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_suspension_reason_check" CHECK (
  "suspension_reason_code" IS NULL
  OR "suspension_reason_code" IN ('SELLER_IDENTITY', 'LEGAL_REQUEST', 'FRAUD_SUSPECTED', 'OTHER'));
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_suspension_reason_len_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_suspension_reason_len_check" CHECK (
  "suspension_reason" IS NULL OR char_length("suspension_reason") BETWEEN 1 AND 1000);
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_suspension_open_ids_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_suspension_open_ids_check" CHECK (
  "suspension_open_event_ids" IS NULL OR jsonb_typeof("suspension_open_event_ids") = 'array');
--> statement-breakpoint
GRANT UPDATE ("suspended_at", "suspension_reason_code", "suspension_reason", "suspension_approval_id", "suspension_open_event_ids") ON "production" TO core_ops;
