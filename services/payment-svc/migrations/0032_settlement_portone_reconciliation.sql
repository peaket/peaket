-- 포트원 사후 대사(F-07-7 LCH-120, ADR-0370 결정 8, docs/data.md portone_transfer·portone_ledger_sync·settlement_alert_request·portone_partner).
-- schema.ts에서 drizzle-kit이 만들었다. 번호 0031은 다른 갈래 몫으로 비워 두었다(감독 결정, 합칠 때 다시 맞춘다).
-- pg_balance_reconciliation.pg CHECK는 0029부터 PORTONE을 받으므로 고치지 않는다. 계좌번호 전체·예금주명 칸은 없다.
CREATE TABLE "portone_ledger_sync" (
	"name" text PRIMARY KEY NOT NULL,
	"last_success_at" timestamp with time zone,
	"read_through" timestamp with time zone,
	"halted_on" date,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portone_ledger_sync_name_check" CHECK ("portone_ledger_sync"."name" in ('WITHDRAWAL', 'PARTNER_ACCOUNT'))
);
--> statement-breakpoint
CREATE TABLE "portone_transfer" (
	"transfer_id" text PRIMARY KEY NOT NULL,
	"withdrawal_type" text,
	"payout_id" uuid,
	"amount" bigint NOT NULL,
	"bank_code" text,
	"account_last4" text,
	"holder_matched" boolean,
	"check_result" text NOT NULL,
	"transferred_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portone_transfer_check_result_check" CHECK ("portone_transfer"."check_result" in ('MATCHED', 'MISMATCH', 'UNLINKED')),
	CONSTRAINT "portone_transfer_account_last4_check" CHECK ("portone_transfer"."account_last4" is null or "portone_transfer"."account_last4" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "settlement_alert_request" (
	"event_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone,
	"refused_count" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp with time zone,
	"last_refusal" text,
	CONSTRAINT "settlement_alert_request_severity_check" CHECK ("settlement_alert_request"."severity" in ('SEV2', 'SEV3')),
	CONSTRAINT "settlement_alert_request_refused_count_check" CHECK ("settlement_alert_request"."refused_count" >= 0),
	CONSTRAINT "settlement_alert_request_last_refusal_check" CHECK ("settlement_alert_request"."last_refusal" is null or "settlement_alert_request"."last_refusal" in ('NOT_ACCEPTED', 'HTTP_400', 'HTTP_422'))
);
--> statement-breakpoint
ALTER TABLE "settlement_case_request" DROP CONSTRAINT "settlement_case_request_kind_check";--> statement-breakpoint
ALTER TABLE "portone_partner" ADD COLUMN "last_account_check" text;--> statement-breakpoint
ALTER TABLE "portone_partner" ADD COLUMN "last_account_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "portone_transfer" ADD CONSTRAINT "portone_transfer_payout_id_payout_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portone_transfer_payout_idx" ON "portone_transfer" USING btree ("payout_id") WHERE "portone_transfer"."payout_id" is not null;--> statement-breakpoint
CREATE INDEX "settlement_alert_request_unsent_idx" ON "settlement_alert_request" USING btree ("created_at") WHERE "settlement_alert_request"."requested_at" is null and "settlement_alert_request"."failed_at" is null;--> statement-breakpoint
ALTER TABLE "portone_partner" ADD CONSTRAINT "portone_partner_last_account_check_check" CHECK ("portone_partner"."last_account_check" is null or "portone_partner"."last_account_check" in ('MATCHED', 'MISMATCH'));--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_kind_check" CHECK ("settlement_case_request"."kind" in ('PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH', 'PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH'));