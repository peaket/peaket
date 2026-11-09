-- 관리 계정 패스키와 재인증 기록, 알림 종류 PASSKEY_ADDED·PASSKEY_REMOVED(docs/data.md admin_passkey·admin_reauth·admin_security_notice.kind, docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, ADR-0206).
-- 자격 ID는 모든 계정 사이에서 하나다(고유 색인). 알림 종류 CHECK를 다시 만든다. admin_security_notice는 아직 운영에 나가지 않은 작은 표라 바로 검사한다.
CREATE TABLE "admin_passkey" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}'::text[] NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"aaguid" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "admin_passkey_device_type_check" CHECK ("admin_passkey"."device_type" in ('singleDevice', 'multiDevice')),
	CONSTRAINT "admin_passkey_credential_len_check" CHECK (octet_length("admin_passkey"."credential_id") between 1 and 1023),
	CONSTRAINT "admin_passkey_sign_count_check" CHECK ("admin_passkey"."sign_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin_reauth" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"admin_session_id" uuid NOT NULL,
	"aud" text NOT NULL,
	"act" text NOT NULL,
	"factors" text[] NOT NULL,
	"passkey_id" uuid,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "admin_reauth_aud_check" CHECK ("admin_reauth"."aud" in ('partner', 'ops')),
	CONSTRAINT "admin_reauth_act_check" CHECK ("admin_reauth"."act" in ('OPS_COMMAND', 'APPROVAL', 'PERMISSION_CHANGE', 'PAYOUT_ACCOUNT', 'BOOKER_EXPORT', 'AUTHORITY_DATA', 'ACCOUNT_SECURITY'))
);
--> statement-breakpoint
ALTER TABLE "admin_security_notice" DROP CONSTRAINT "admin_security_notice_kind_check";--> statement-breakpoint
ALTER TABLE "admin_passkey" ADD CONSTRAINT "admin_passkey_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reauth" ADD CONSTRAINT "admin_reauth_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_reauth" ADD CONSTRAINT "admin_reauth_admin_session_id_admin_session_id_fk" FOREIGN KEY ("admin_session_id") REFERENCES "public"."admin_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_passkey_credential_key" ON "admin_passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "admin_passkey_account_idx" ON "admin_passkey" USING btree ("admin_account_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_reauth_issued_idx" ON "admin_reauth" USING btree ("issued_at");--> statement-breakpoint
CREATE INDEX "admin_reauth_account_idx" ON "admin_reauth" USING btree ("admin_account_id","issued_at");--> statement-breakpoint
ALTER TABLE "admin_security_notice" ADD CONSTRAINT "admin_security_notice_kind_check" CHECK ("admin_security_notice"."kind" in ('TIMED_LOCK', 'PASSWORD_FAILURE_NOTICE', 'MULTI_SOURCE_ALERT', 'PROTECT_LOCK', 'SESSION_LIMIT', 'UNLOCK_LINK', 'UNLOCKED', 'PASSWORD_ONLY_LOGIN', 'INVITATION', 'PASSKEY_ADDED', 'PASSKEY_REMOVED'));