-- 토스 지급대행의 남은 몫(F-07-6 LCH-110, ADR-0369, docs/data.md payout·payout_batch·toss_seller·payout_retry_audit·settlement_case_request·pg_balance_reconciliation).
-- 표 정의는 schema.ts에서 drizzle-kit이 만들었고, 옛 행을 채우는 문장(payout.payout_date, toss_seller 옮기기)만 손으로 더했다.
-- 미수금 이동 표(0028의 이름 바꾸기·옛 이름 뷰)는 건드리지 않는다(정리 목록 G-26).
CREATE TABLE "payout_retry_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payout_id" uuid NOT NULL,
	"new_payout_id" uuid NOT NULL,
	"old_seq" integer NOT NULL,
	"new_seq" integer NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_retry_audit_reason_check" CHECK ("payout_retry_audit"."reason" in ('ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN', 'DATE_ERROR'))
);
--> statement-breakpoint
CREATE TABLE "pg_balance_reconciliation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pg" text NOT NULL,
	"pg_store" text NOT NULL,
	"kind" text NOT NULL,
	"period_month" date,
	"batch_id" uuid,
	"cutoff_at" timestamp with time zone NOT NULL,
	"approved_amount" bigint NOT NULL,
	"refunded_amount" bigint NOT NULL,
	"pg_fee_amount" bigint NOT NULL,
	"paid_out_amount" bigint NOT NULL,
	"peaket_withdrawn_amount" bigint NOT NULL,
	"expected_amount" bigint NOT NULL,
	"observed_amount" bigint NOT NULL,
	"diff_amount" bigint NOT NULL,
	"severity" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pg_balance_reconciliation_pg_check" CHECK ("pg_balance_reconciliation"."pg" in ('TOSS', 'PORTONE')),
	CONSTRAINT "pg_balance_reconciliation_pg_store_check" CHECK ("pg_balance_reconciliation"."pg_store" in ('STANDARD', 'ESCROW')),
	CONSTRAINT "pg_balance_reconciliation_kind_check" CHECK ("pg_balance_reconciliation"."kind" in ('MONTHLY', 'BATCH')),
	CONSTRAINT "pg_balance_reconciliation_severity_check" CHECK ("pg_balance_reconciliation"."severity" in ('NONE', 'CASE', 'SEV3'))
);
--> statement-breakpoint
CREATE TABLE "settlement_case_request" (
	"event_key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone,
	CONSTRAINT "settlement_case_request_kind_check" CHECK ("settlement_case_request"."kind" in ('PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH'))
);
--> statement-breakpoint
CREATE TABLE "toss_seller" (
	"promoter_id" uuid NOT NULL,
	"pg_store" text NOT NULL,
	"toss_seller_id" text NOT NULL,
	"ref_seller_id" text NOT NULL,
	"status" text NOT NULL,
	"business_type" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"status_checked_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "toss_seller_promoter_id_pg_store_pk" PRIMARY KEY("promoter_id","pg_store"),
	CONSTRAINT "toss_seller_pg_store_check" CHECK ("toss_seller"."pg_store" in ('STANDARD', 'ESCROW')),
	CONSTRAINT "toss_seller_status_check" CHECK ("toss_seller"."status" in ('PENDING', 'APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED')),
	CONSTRAINT "toss_seller_business_type_check" CHECK ("toss_seller"."business_type" in ('INDIVIDUAL_BUSINESS', 'CORPORATE'))
);
--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "payout_date" date;--> statement-breakpoint
-- 옛 지급 건의 예약 지급일은 그 묶음의 지급일이다(시험 리뷰 TR-09)
UPDATE "payout" SET "payout_date" = "payout_batch"."payout_date" FROM "payout_batch" WHERE "payout"."batch_id" = "payout_batch"."id";--> statement-breakpoint
ALTER TABLE "payout" ALTER COLUMN "payout_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "retry_of_payout_id" uuid;--> statement-breakpoint
ALTER TABLE "payout" ADD COLUMN "auto_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_batch" ADD COLUMN "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_batch" ADD COLUMN "next_submit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_batch" ADD COLUMN "submit_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_batch" ADD COLUMN "last_submit_error" text;--> statement-breakpoint
ALTER TABLE "payout_batch" ADD COLUMN "date_retry_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_webhook_receipt" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "payout_retry_audit" ADD CONSTRAINT "payout_retry_audit_payout_id_payout_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_retry_audit" ADD CONSTRAINT "payout_retry_audit_new_payout_id_payout_id_fk" FOREIGN KEY ("new_payout_id") REFERENCES "public"."payout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_retry_audit_payout_idx" ON "payout_retry_audit" USING btree ("payout_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pg_balance_reconciliation_month_uidx" ON "pg_balance_reconciliation" USING btree ("pg","pg_store","period_month") WHERE "pg_balance_reconciliation"."kind" = 'MONTHLY';--> statement-breakpoint
CREATE UNIQUE INDEX "pg_balance_reconciliation_batch_uidx" ON "pg_balance_reconciliation" USING btree ("batch_id") WHERE "pg_balance_reconciliation"."kind" = 'BATCH';--> statement-breakpoint
CREATE INDEX "pg_balance_reconciliation_last_idx" ON "pg_balance_reconciliation" USING btree ("pg","pg_store","cutoff_at");--> statement-breakpoint
CREATE INDEX "settlement_case_request_unsent_idx" ON "settlement_case_request" USING btree ("created_at") WHERE "settlement_case_request"."requested_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "toss_seller_toss_seller_id_uidx" ON "toss_seller" USING btree ("toss_seller_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toss_seller_ref_seller_id_uidx" ON "toss_seller" USING btree ("ref_seller_id");--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_retry_of_payout_id_payout_id_fk" FOREIGN KEY ("retry_of_payout_id") REFERENCES "public"."payout"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_unfinished_idx" ON "payout" USING btree ("status") WHERE "payout"."status" in ('REQUESTED', 'IN_PROGRESS');--> statement-breakpoint
CREATE INDEX "payout_retry_of_idx" ON "payout" USING btree ("retry_of_payout_id") WHERE "payout"."retry_of_payout_id" is not null;--> statement-breakpoint
CREATE INDEX "payout_batch_next_submit_idx" ON "payout_batch" USING btree ("next_submit_at") WHERE "payout_batch"."next_submit_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_webhook_receipt_event_id_uidx" ON "settlement_webhook_receipt" USING btree ("event_id") WHERE "settlement_webhook_receipt"."event_id" is not null;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_failure_class_check" CHECK ("payout"."failure_class" is null or "payout"."failure_class" in ('ACCOUNT', 'TRANSIENT', 'LIMIT_KYC', 'UNKNOWN'));--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_auto_retry_count_check" CHECK ("payout"."auto_retry_count" >= 0);--> statement-breakpoint
ALTER TABLE "payout_batch" ADD CONSTRAINT "payout_batch_submit_attempts_check" CHECK ("payout_batch"."submit_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "payout_batch" ADD CONSTRAINT "payout_batch_last_submit_error_check" CHECK ("payout_batch"."last_submit_error" is null or char_length("payout_batch"."last_submit_error") <= 200);--> statement-breakpoint
-- 0026의 파트너당 셀러 한 칸(seller_kyc.toss_seller_id·toss_seller_status)을 일반 상점 셀러 행으로 옮긴다(ADR-0369 결정 3).
-- 사업자 유형은 [가정] CORPORATE이고(정리 목록 C-03) 다음 셀러 단건 조회가 상태를 고친다. 옛 칸은 지우지 않는다(정리 목록 C-02)
INSERT INTO "toss_seller" ("promoter_id", "pg_store", "toss_seller_id", "ref_seller_id", "status", "business_type", "registered_at", "status_checked_at", "updated_at")
SELECT "promoter_id", 'STANDARD', "toss_seller_id", "promoter_id"::text || '-STANDARD', "toss_seller_status", 'CORPORATE', "updated_at", "updated_at", "updated_at"
FROM "seller_kyc" WHERE "toss_seller_id" IS NOT NULL
ON CONFLICT DO NOTHING;