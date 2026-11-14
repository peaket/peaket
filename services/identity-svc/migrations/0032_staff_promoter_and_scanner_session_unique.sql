-- 기기 승인 로그인(GAT-220): 배정의 파트너를 남겨 기기 승인 때 기기의 배정 파트너와 대조한다(I-T22).
-- 같은 기기의 활성 스캐너 세션은 하나만 둔다(교대는 승인 트랜잭션이 이전 세션을 끝낸다).
ALTER TABLE "staff_assignment" ADD COLUMN "promoter_id" uuid;--> statement-breakpoint
DROP INDEX IF EXISTS "scanner_session_device_active_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "scanner_session_device_active_key" ON "scanner_session" USING btree ("scanner_device_id") WHERE "scanner_session"."terminated_at" is null;
