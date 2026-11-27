-- 관리 계정 초대 수락 단계(F-09-6 BOT-152, 동결 로컬 전용).
-- 초대 링크로 수락을 시작하면 30분짜리 단계 토큰의 SHA-256과 단계를 적는다.
-- 비밀번호(PASSWORD) → TOTP(TOTP) → 패스키(PASSKEY) 순서이고, 완료·재시작·재초대·만료 때 지운다.
ALTER TABLE "admin_account" ADD COLUMN "invite_step_hash" bytea;
ALTER TABLE "admin_account" ADD COLUMN "invite_step_expires_at" timestamptz;
ALTER TABLE "admin_account" ADD COLUMN "invite_step_stage" text;
ALTER TABLE "admin_account" ADD COLUMN "invite_step_code_failures" integer NOT NULL DEFAULT 0;
ALTER TABLE "admin_account" ADD CONSTRAINT "admin_account_invite_step_stage_check" CHECK ("invite_step_stage" is null or "invite_step_stage" in ('PASSWORD', 'TOTP', 'PASSKEY'));
