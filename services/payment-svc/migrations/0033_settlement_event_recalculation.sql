-- 회차 취소·연기 환급의 정산 다시 계산·계산 뒤 환급 미수금·배상 송금 결과 확정(F-07-8 GAT-120·GAT-130, ADR-0380, docs/data.md settlement_recalculation·settlement_refund_scan·partner_receivable·payment_cancel·receivable_movement).
-- 앞 몫은 schema.ts에서 drizzle-kit이 만들었다(새 표 둘, 보류 사유·이동 종류·이의 결과·CS 건 종류 CHECK 넓히기. 제약 이름은 그대로다).
-- 뒤 몫(맨 끝 주석 아래)은 손으로 썼다: payment_cancel·partner_receivable·compensation_transfer의 표 정의는 고정 시험(payment-schema BAT-425·PRF181)이 0024 스냅숏 모양에 묶어 schema.ts를 바꾸지 않으므로
-- 이 파일과 저장소의 SQL로만 다룬다(스냅숏에 없다). 표 이름 바꾸기 확장 단계의 옛 이름 뷰 receivable_move는 새 칸 reverses_id까지 그대로 보이게 다시 만든다.
CREATE TABLE "settlement_recalculation" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"partial" boolean DEFAULT false NOT NULL,
	"held_statement_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skipped_statement_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retry_statement_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settlement_recalculation_kind_check" CHECK ("settlement_recalculation"."kind" in ('CANCEL', 'POSTPONE')),
	CONSTRAINT "settlement_recalculation_state_check" CHECK ("settlement_recalculation"."state" in ('PENDING', 'DONE'))
);
--> statement-breakpoint
CREATE TABLE "settlement_refund_scan" (
	"name" text PRIMARY KEY NOT NULL,
	"read_through" timestamp with time zone NOT NULL,
	"read_through_payment_id" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settlement_refund_scan_name_check" CHECK ("settlement_refund_scan"."name" in ('EVENT_REFUND'))
);
--> statement-breakpoint
ALTER TABLE "receivable_movement" DROP CONSTRAINT "receivable_movement_kind_check";--> statement-breakpoint
ALTER TABLE "settlement_case_request" DROP CONSTRAINT "settlement_case_request_kind_check";--> statement-breakpoint
ALTER TABLE "settlement_statement" DROP CONSTRAINT "settlement_statement_hold_reason_check";--> statement-breakpoint
ALTER TABLE "statement_dispute" DROP CONSTRAINT "statement_dispute_result_check";--> statement-breakpoint
ALTER TABLE "receivable_movement" ADD COLUMN "reverses_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement_statement" ADD COLUMN "commission_rate_bp" integer;--> statement-breakpoint
CREATE INDEX "settlement_recalculation_pending_idx" ON "settlement_recalculation" USING btree ("event_id") WHERE "settlement_recalculation"."state" = 'PENDING';--> statement-breakpoint
ALTER TABLE "receivable_movement" ADD CONSTRAINT "receivable_movement_kind_check" CHECK ("receivable_movement"."kind" in ('OFFSET', 'GUARANTEE', 'COLLECTED', 'WRITE_OFF', 'REVERSAL', 'SUPERSEDED'));--> statement-breakpoint
ALTER TABLE "settlement_case_request" ADD CONSTRAINT "settlement_case_request_kind_check" CHECK ("settlement_case_request"."kind" in ('PAYOUT_ERROR', 'PAYOUT_FAILED', 'PAYOUT_DELAYED', 'SELLER_KYC_REQUIRED', 'PG_BALANCE_MISMATCH', 'PORTONE_PAYOUT_EXECUTION', 'PORTONE_LEDGER_MISMATCH', 'SETTLEMENT_ADJUSTMENT_SUGGESTED'));--> statement-breakpoint
ALTER TABLE "settlement_statement" ADD CONSTRAINT "settlement_statement_commission_rate_check" CHECK ("settlement_statement"."commission_rate_bp" is null or "settlement_statement"."commission_rate_bp" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "settlement_statement" ADD CONSTRAINT "settlement_statement_hold_reason_check" CHECK ("settlement_statement"."hold_reason" is null or "settlement_statement"."hold_reason" in ('KYC', 'ACCOUNT_CHANGE', 'BALANCE', 'ACCOUNT_MISMATCH', 'SALE_SUSPENDED', 'RECALCULATION'));--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD CONSTRAINT "statement_dispute_result_check" CHECK ("statement_dispute"."result" is null or "statement_dispute"."result" in ('ADJUSTED', 'DISMISSED', 'SUPERSEDED'));--> statement-breakpoint
-- ---- 손으로 쓴 몫 ----
-- 결제 취소의 정산 부담(PARTNER|PEAKET, 기본 PARTNER, 옛 행 PARTNER). PEAKET은 재량 면제분·시스템 잘못 환불이라 정산 환급·미수금에 넣지 않는다(settlement §7)
ALTER TABLE "payment_cancel" ADD COLUMN "settlement_burden" text DEFAULT 'PARTNER' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD CONSTRAINT "payment_cancel_settlement_burden_check" CHECK ("payment_cancel"."settlement_burden" in ('PARTNER', 'PEAKET'));--> statement-breakpoint
-- 계산 뒤 환급 훑기(끝난 취소의 끝난 시각 차례)
CREATE INDEX "payment_cancel_settled_idx" ON "payment_cancel" USING btree ("canceled_at","payment_id") WHERE "payment_cancel"."status" = 'CANCELED';--> statement-breakpoint
-- 계산 뒤 환급 미수금의 다섯 칸(다른 원인은 null, 옛 행 그대로). 금액 = 환급액 − 수수료 몫 − 부가세
ALTER TABLE "partner_receivable" ADD COLUMN "statement_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "commission_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "refund_amount" bigint;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "commission_share" bigint;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "commission_vat_share" bigint;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD CONSTRAINT "partner_receivable_refund_parts_check" CHECK ("partner_receivable"."refund_amount" is null or ("partner_receivable"."commission_share" is not null and "partner_receivable"."commission_vat_share" is not null and "partner_receivable"."commission_share" >= 0 and "partner_receivable"."commission_vat_share" >= 0 and "partner_receivable"."amount" = "partner_receivable"."refund_amount" - "partner_receivable"."commission_share" - "partner_receivable"."commission_vat_share"));--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD CONSTRAINT "partner_receivable_commission_rate_check" CHECK ("partner_receivable"."commission_rate_bp" is null or "partner_receivable"."commission_rate_bp" between 0 and 10000);--> statement-breakpoint
CREATE INDEX "partner_receivable_refund_statement_idx" ON "partner_receivable" USING btree ("statement_id") WHERE "partner_receivable"."cause" = 'REFUND_AFTER_PAYOUT' and "partner_receivable"."statement_id" is not null;--> statement-breakpoint
-- 배상 송금 결과 확정 바퀴가 읽는 REQUESTED 행(transfer-refund §6 '송금 결과 확정')
CREATE INDEX "compensation_transfer_requested_idx" ON "compensation_transfer" USING btree ("status") WHERE "compensation_transfer"."status" = 'REQUESTED';--> statement-breakpoint
-- 옛 이름 뷰(0028)가 표의 칸을 빠짐없이 보이게 reverses_id를 끝에 더해 다시 만든다(이 판의 앱은 옛 이름으로 읽고 쓴다)
CREATE OR REPLACE VIEW "receivable_move" WITH (security_invoker = true) AS SELECT "id", "receivable_id", "statement_id", "amount", "kind", "moved_at", "reverses_id" FROM "receivable_movement";
