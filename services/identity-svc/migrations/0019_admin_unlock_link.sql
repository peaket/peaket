-- 관리 계정 본인 해제 링크와 알림 다시 시도 칸(docs/data.md admin_unlock_link·admin_security_notice.attempts·next_attempt_at, docs/features/identity.md §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', BUILD_ORDER BOT-121).
-- 알림 종류 CHECK를 다시 만든다(UNLOCK_LINK·UNLOCKED). admin_security_notice는 아직 운영에 나가지 않은 작은 표라 바로 검사한다.
CREATE TABLE "admin_unlock_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"code_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "admin_security_notice" DROP CONSTRAINT "admin_security_notice_kind_check";--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_unlock_link" ADD CONSTRAINT "admin_unlock_link_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_unlock_link_token_key" ON "admin_unlock_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_unlock_link_live_idx" ON "admin_unlock_link" USING btree ("admin_account_id") WHERE "admin_unlock_link"."used_at" is null and "admin_unlock_link"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT', 'UNLOCK_LINK', 'UNLOCKED'));
