-- 관리 계정 TOTP와 로그인 2단계의 표·칸(docs/data.md admin_session·admin_recovery_code·admin_account.totp_pending_enc·totp_last_step, docs/features/identity.md §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120).
-- 알림 종류 CHECK를 다시 만든다(SESSION_LIMIT). admin_security_notice는 BOT-111에서 만든 작은 표이고 아직 운영에 나가지 않아 바로 검사한다.
CREATE TABLE "admin_recovery_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"code_phc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"aud" text NOT NULL,
	"refresh_hash" "bytea" NOT NULL,
	"refresh_family" uuid NOT NULL,
	"pair_ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	CONSTRAINT "admin_session_aud_check" CHECK ("admin_session"."aud" in ('partner', 'ops'))
);
--> statement-breakpoint
ALTER TABLE "admin_security_notice" DROP CONSTRAINT "admin_security_notice_kind_check";--> statement-breakpoint
ALTER TABLE "admin_account" ADD COLUMN "totp_pending_enc" "bytea";--> statement-breakpoint
ALTER TABLE "admin_account" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "admin_recovery_code" ADD CONSTRAINT "admin_recovery_code_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_recovery_code_account_idx" ON "admin_recovery_code" USING btree ("admin_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_session_refresh_key" ON "admin_session" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "admin_session_live_idx" ON "admin_session" USING btree ("admin_account_id","idle_expires_at") WHERE "admin_session"."terminated_at" is null;--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT'));
