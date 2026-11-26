-- F-05-11 양도 뒤 몫: Outbox 부모 표와 transfer_notice·transfer_withdrawal_run
-- (docs/data.md §4 `transfer_notice`, docs/features/notify.md §4.8, docs/features/identity.md §8, 계획 §3-2·§3-10).
-- Outbox는 packages/platform/template/migrations/0002_outbox.sql과 같은 모양이다. 파티션은 @peaket/platform의 ensureOutboxPartitions가 만든다.
CREATE SEQUENCE "outbox_seq" AS bigint;
CREATE TABLE "outbox" (
	"id" uuid NOT NULL,
	"seq" bigint NOT NULL DEFAULT nextval('outbox_seq'),
	"topic" text NOT NULL,
	"msg_key" text NOT NULL,
	"payload" bytea NOT NULL,
	"headers" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
) PARTITION BY RANGE ("id");
ALTER SEQUENCE "outbox_seq" OWNED BY "outbox"."seq";
CREATE INDEX "outbox_unsent_idx" ON "outbox" ("seq") WHERE "sent_at" IS NULL;

-- 양도 사건 알림 행. 사건마다 두 사람(약한 재인증은 한 사람)이고, 중복 키가 같은 사건의 재전송을 한 행으로 막는다.
CREATE TABLE IF NOT EXISTS "transfer_notice" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"party" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL DEFAULT 0,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "transfer_notice_type_check" CHECK ("type" IN (
		'TRANSFER_OFFERED', 'TRANSFER_ACCEPTED', 'TRANSFER_REJECTED', 'TRANSFER_WITHDRAWN',
		'TRANSFER_EXPIRED', 'TICKET_RETURNED', 'TRANSFER_WEAK_REAUTH')),
	CONSTRAINT "transfer_notice_party_check" CHECK ("party" IN ('SENDER', 'RECIPIENT', 'PAYER', 'RETURNER')),
	CONSTRAINT "transfer_notice_reason_check" CHECK ("reason" IS NULL OR "reason" IN ('SENDER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'OTHER')),
	CONSTRAINT "transfer_notice_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "transfer_notice_event_account_uq" ON "transfer_notice" ("type", "offer_id", "account_id");
CREATE INDEX IF NOT EXISTS "transfer_notice_due_idx" ON "transfer_notice" ("next_attempt_at") WHERE "sent_at" IS NULL;
CREATE INDEX IF NOT EXISTS "transfer_notice_sent_idx" ON "transfer_notice" ("sent_at") WHERE "sent_at" IS NOT NULL;

-- 탈퇴 참여자 호출 기록(IR-03·15). deadline_at_ms를 실제 DB에 남기고, 가장 오래된 PENDING의 나이를 지표로 낸다.
CREATE TABLE IF NOT EXISTS "transfer_withdrawal_run" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"deadline_at" timestamp with time zone,
	"state" text NOT NULL,
	"returned_tickets" integer NOT NULL DEFAULT 0,
	"withdrawn_offers" integer NOT NULL DEFAULT 0,
	"rejected_offers" integer NOT NULL DEFAULT 0,
	"pending_received_tickets" integer NOT NULL DEFAULT 0,
	"pending_sent_offers" integer NOT NULL DEFAULT 0,
	"pending_received_offers" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transfer_withdrawal_run_state_check" CHECK ("state" IN ('DONE', 'PENDING'))
);
CREATE INDEX IF NOT EXISTS "transfer_withdrawal_run_account_idx" ON "transfer_withdrawal_run" ("account_id", "created_at" DESC);
