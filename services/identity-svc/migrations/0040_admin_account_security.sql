-- F-07-13 SCR-020 '내 계정': 관리 세션의 화면용 기기 이름과 인증 앱 다시 등록의 세션 묶기(동결 로컬 전용).
-- admin_session.device_label은 로그인 때 User-Agent에서 정해진 낱말만 뽑은 1~40자다. 원문은 두지 않고, 세션이 끝나면 비운다.
-- admin_account.totp_pending_session_id는 대기 시드를 시작한 세션이고, totp_pending_failures는 다시 등록 확인 코드 실패 수다.
ALTER TABLE "admin_session" ADD COLUMN "device_label" text;
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_device_label_length_check" CHECK ("device_label" is null or char_length("device_label") between 1 and 40);
ALTER TABLE "admin_account" ADD COLUMN "totp_pending_session_id" uuid;
ALTER TABLE "admin_account" ADD COLUMN "totp_pending_failures" integer NOT NULL DEFAULT 0;
ALTER TABLE "admin_account" ADD CONSTRAINT "admin_account_totp_pending_failures_check" CHECK ("totp_pending_failures" >= 0);
