-- 관리 계정 로그인 1단계의 표 둘(docs/data.md admin_login_step·admin_security_notice, docs/features/identity.md §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
-- 새 표라 CHECK·외래키·색인을 바로 만든다. 로그인 단계는 2단계(BOT-120)가 쓰고, 알림은 메일 대행 단계가 읽어 보낸다.
CREATE TABLE "admin_login_step" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"aud" text NOT NULL,
	"pair_ref" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "admin_login_step_aud_check" CHECK ("admin_login_step"."aud" in ('partner', 'ops'))
);
--> statement-breakpoint
CREATE TABLE "admin_security_notice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK'))
);
--> statement-breakpoint
ALTER TABLE "admin_login_step" ADD CONSTRAINT "admin_login_step_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_login_step_token_key" ON "admin_login_step" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "admin_login_step_account_idx" ON "admin_login_step" USING btree ("admin_account_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_security_notice_unsent_idx" ON "admin_security_notice" USING btree ("created_at") WHERE "admin_security_notice"."sent_at" is null;
