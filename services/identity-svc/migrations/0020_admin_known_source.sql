-- 익숙한 출발지와 비밀번호만 맞은 로그인 칸(docs/data.md admin_known_source·admin_login_step.known_source·password_only_noticed_at, docs/features/identity.md §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', BUILD_ORDER BOT-123).
-- 알림 종류 CHECK를 다시 만든다(PASSWORD_ONLY_LOGIN). admin_security_notice는 아직 운영에 나가지 않은 작은 표라 바로 검사한다.
CREATE TABLE "admin_known_source" (
	"admin_account_id" uuid NOT NULL,
	"pair_ref" text NOT NULL,
	"last_success_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_known_source_admin_account_id_pair_ref_pk" PRIMARY KEY("admin_account_id","pair_ref")
);
--> statement-breakpoint
ALTER TABLE "admin_security_notice" DROP CONSTRAINT "admin_security_notice_kind_check";--> statement-breakpoint
ALTER TABLE "admin_login_step" ADD COLUMN "known_source" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_login_step" ADD COLUMN "password_only_noticed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_known_source" ADD CONSTRAINT "admin_known_source_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_known_source_last_idx" ON "admin_known_source" USING btree ("last_success_at");--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT', 'UNLOCK_LINK', 'UNLOCKED', 'PASSWORD_ONLY_LOGIN'));
