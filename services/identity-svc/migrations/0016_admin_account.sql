-- 관리 계정(파트너·운영자) 표(docs/data.md admin_account, docs/features/identity.md §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', BUILD_ORDER BOT-110).
-- 새 표라 CHECK와 삭제하지 않은 계정 사이의 이메일 UNIQUE(부분 색인)를 바로 만든다. 쓰는 길은 단계마다 붙인다(BOT-110·111·120·121·150).
CREATE TABLE "admin_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"promoter_id" uuid,
	"status" text NOT NULL,
	"email" text,
	"display_name" text,
	"invite_token_hash" "bytea",
	"invite_expires_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"version" bigint DEFAULT 1 NOT NULL,
	"password_phc" text,
	"totp_seed_enc" "bytea",
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"second_factor_failures" integer DEFAULT 0 NOT NULL,
	"password_failure_total" integer DEFAULT 0 NOT NULL,
	"breach_checked_at" timestamp with time zone,
	"password_change_required" boolean DEFAULT false NOT NULL,
	"lock_kind" text DEFAULT 'NONE' NOT NULL,
	"locked_until" timestamp with time zone,
	"recent_lock_at" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locked_at" timestamp with time zone,
	"lock_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_account_role_check" CHECK ("admin_account"."role" in ('partner_admin', 'partner_member', 'viewer', 'operator', 'commander', 'cs_agent', 'cs_lead')),
	CONSTRAINT "admin_account_status_check" CHECK ("admin_account"."status" in ('INVITED', 'ACTIVE', 'INVITE_EXPIRED', 'REMOVED')),
	CONSTRAINT "admin_account_lock_kind_check" CHECK ("admin_account"."lock_kind" in ('NONE', 'TIMED', 'PROTECT')),
	CONSTRAINT "admin_account_lock_reason_check" CHECK ("admin_account"."lock_reason" is null or "admin_account"."lock_reason" in ('FAILED_ATTEMPTS', 'SECOND_FACTOR_FAILURES', 'PASSWORD_FAILURE_TOTAL')),
	CONSTRAINT "admin_account_partner_check" CHECK (("admin_account"."role" in ('partner_admin', 'partner_member')) = ("admin_account"."promoter_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_account_email_live_key" ON "admin_account" USING btree ("email") WHERE "admin_account"."status" <> 'REMOVED';