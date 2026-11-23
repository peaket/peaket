-- 포트원 지급대행 등록·정산 계좌 변경 기록·ops 받기 거절 세기(F-07-7 LCH-120, ADR-0370 결정 1·5·7, docs/data.md payout_account·payout_account_change·portone_partner·settlement_case_request·statement_dispute).
-- schema.ts에서 drizzle-kit이 만들었다. 계좌번호·예금주명 칸은 어느 표에도 없다. 미수금 이동 표(0028)는 건드리지 않는다.
CREATE TABLE "payout_account_change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"reauth_jti" text NOT NULL,
	"reauth_factors" text[] DEFAULT '{}'::text[] NOT NULL,
	"result" text NOT NULL,
	"bank_code" text NOT NULL,
	"account_last4" text NOT NULL,
	"hold_until" timestamp with time zone,
	"agency_results" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"audit_sent_at" timestamp with time zone,
	"audit_refused_count" integer DEFAULT 0 NOT NULL,
	"audit_failed_at" timestamp with time zone,
	CONSTRAINT "payout_account_change_result_check" CHECK ("payout_account_change"."result" in ('ACCEPTED', 'HOLDER_MISMATCH', 'AGENCY_FAILED')),
	CONSTRAINT "payout_account_change_account_last4_check" CHECK ("payout_account_change"."account_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "payout_account_change_audit_refused_count_check" CHECK ("payout_account_change"."audit_refused_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "portone_partner" (
	"promoter_id" uuid PRIMARY KEY NOT NULL,
	"portone_partner_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"account_updated_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlement_case_request" DROP CONSTRAINT "settlement_case_request_kind_check";--> statement-breakpoint
DROP INDEX "settlement_case_request_unsent_idx";--> statement-breakpoint
ALTER TABLE "payout_account" ADD COLUMN "agency_sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD COLUMN "refused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD COLUMN "last_refusal" text;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD COLUMN "case_refused_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD COLUMN "case_failed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_account_change_reauth_jti_uidx" ON "payout_account_change" USING btree ("reauth_jti");--> statement-breakpoint
CREATE INDEX "payout_account_change_unsent_idx" ON "payout_account_change" USING btree ("created_at") WHERE "payout_account_change"."audit_sent_at" is null and "payout_account_change"."audit_failed_at" is null;--> statement-breakpoint
CREATE INDEX "payout_account_change_promoter_idx" ON "payout_account_change" USING btree ("promoter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portone_partner_portone_partner_id_uidx" ON "portone_partner" USING btree ("portone_partner_id");--> statement-breakpoint
CREATE INDEX "settlement_case_request_unsent_idx" ON "settlement_case_request" USING btree ("created_at") WHERE "settlement_case_request"."requested_at" is null and "settlement_case_request"."failed_at" is null;--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_detail_check" CHECK ("settlement_case_request"."detail" is null or char_length("settlement_case_request"."detail") between 1 and 2000);--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_refused_count_check" CHECK ("settlement_case_request"."refused_count" >= 0);--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_last_refusal_check" CHECK ("settlement_case_request"."last_refusal" is null or "settlement_case_request"."last_refusal" in ('NOT_ACCEPTED', 'HTTP_400', 'HTTP_422'));--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_kind_check" CHECK ("settlement_case_request"."kind" in ('PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH', 'PORTONE_PAYOUT_EXECUTION'));