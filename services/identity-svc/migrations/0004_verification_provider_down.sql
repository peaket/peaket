-- 본인확인 건 상태에 PROVIDER_DOWN(결과 경로에서 기관 장애를 만난 건)을 더한다(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010).
-- 상태 칸의 CHECK는 NOT VALID로 바꾸고 다음 파일에서 따로 검증한다(docs/devops.md §7.2 '부분 인덱스 조건 바꾸기'·'무거운 변경은 정비 시간에').
ALTER TABLE "verification_attempt" DROP CONSTRAINT "verification_attempt_status_check";--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD CONSTRAINT "verification_attempt_status_check" CHECK ("verification_attempt"."status" in ('PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT', 'PROVIDER_DOWN')) NOT VALID;
