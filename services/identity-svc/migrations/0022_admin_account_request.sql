-- 관리 계정 관리 호출의 멱등 기록과 초대 알림 종류(docs/data.md admin_account_request·admin_security_notice.kind INVITATION, docs/features/identity.md §6 '관리 계정 관리 gRPC의 첫 구현', BUILD_ORDER BOT-150).
-- 알림 종류 CHECK를 다시 만든다. admin_security_notice는 아직 운영에 나가지 않은 작은 표라 바로 검사한다.
CREATE TABLE "admin_account_request" (
	"request_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_account_request_kind_check" CHECK ("admin_account_request"."kind" in ('INVITE', 'CHANGE_ROLE', 'REINVITE', 'REMOVE'))
);
--> statement-breakpoint
ALTER TABLE "admin_security_notice" DROP CONSTRAINT "admin_security_notice_kind_check";--> statement-breakpoint
CREATE INDEX "admin_account_request_created_idx" ON "admin_account_request" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT', 'UNLOCK_LINK', 'UNLOCKED', 'PASSWORD_ONLY_LOGIN', 'INVITATION'));