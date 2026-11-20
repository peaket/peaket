-- BAT-616 LCH-080: 파트너 판매 승인 요청·관제 목록·반려 사유(ADR-0327, settlement §3·§9·§10, docs/planning/03 §2.14).
-- 1) production에 마지막 요청 시각(sale_submitted_at)과 마지막 반려 사유(rejection_reason)를 더한다.
-- 2) 반려 사유는 1~1,000자이고 REJECTED일 때만 있다(승인·요청이 사유를 지운다).
-- 3) 관제 목록(승인 대기 오래된 순)이 쓰는 색인을 더한다.
-- 4) 파트너 경로(core_partner)는 판매자 정보 칸과 요청이 쓰는 공연 칸만 쓴다. 관제 경로(core_ops)는 반려 사유 칸까지 쓴다.
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "sale_submitted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_rejection_reason_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_rejection_reason_check" CHECK ("rejection_reason" is null or (char_length("rejection_reason") between 1 and 1000));
--> statement-breakpoint
ALTER TABLE "production" DROP CONSTRAINT IF EXISTS "production_rejection_reason_state_check";
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_rejection_reason_state_check" CHECK ("rejection_reason" is null or "sale_review" = 'REJECTED');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_sale_review_status_idx" ON "production" ("sale_review", "sale_submitted_at", "id");
--> statement-breakpoint
-- 파트너 경로: 판매자 신원정보를 promoter에 쓰고(verified_at은 바꾸지 않는다), 공연의 요청 상태·시각·휠체어석 확인을 쓴다
GRANT SELECT ON "promoter" TO core_partner;
--> statement-breakpoint
GRANT UPDATE ("legal_name", "representative", "address", "phone", "email", "business_reg_no", "mail_order_report_no", "exemption_basis") ON "promoter" TO core_partner;
--> statement-breakpoint
GRANT UPDATE ("sale_review", "sale_submitted_at", "rejection_reason", "accessible_seating_check") ON "production" TO core_partner;
--> statement-breakpoint
-- 관제 경로: 반려 사유·제출 시각을 쓴다(나머지 칸은 0012에서 이미 열었다)
GRANT UPDATE ("sale_submitted_at", "rejection_reason") ON "production" TO core_ops;
