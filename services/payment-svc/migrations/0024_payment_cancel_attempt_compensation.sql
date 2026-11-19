-- BAT-425(ADR-0316·ADR-0317, docs/features/payment.md §4.1·§6, docs/data.md payment_cancel·compensation_transfer).
-- payment_cancel.attempt: 같은 취소 ID의 계좌 다시 받기 시도 번호(0 첫 시도, 1~3 [가정]). 0021·0023의 유일·상태는 그대로다.
-- fail_reason: 앞 시도를 닫은 SUPERSEDED를 더한다(계좌 거절 REFUND_ACCOUNT_INVALID와 함께 FAILED에만).
-- compensation_transfer: 배상 송금 기록. compensation_id 유일(멱등 키), 계좌는 끝 4자리만(POL-014), PAID일 때 receivable_id.
-- partner_receivable: 배상 미수금(COMPENSATION_ADVANCE)은 결제사 무관이라 pg를 NULL로 넓히고, event_id·source_ref와 source_ref 부분 유일을 더한다.
-- 번호는 갈래 3 몫(0023~0024, docs/lanes/coord.md).
CREATE TABLE "compensation_transfer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"compensation_id" uuid NOT NULL,
	"transfer_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"event_id" uuid,
	"amount" bigint NOT NULL,
	"account_last4" text NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"receivable_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "compensation_transfer_amount_check" CHECK ("compensation_transfer"."amount" > 0),
	CONSTRAINT "compensation_transfer_status_check" CHECK ("compensation_transfer"."status" IN ('REQUESTED', 'PAID', 'FAILED', 'UNAVAILABLE')),
	CONSTRAINT "compensation_transfer_account_last4_check" CHECK ("compensation_transfer"."account_last4" ~ '^[0-9]{1,4}$')
);
--> statement-breakpoint
ALTER TABLE "payment_cancel" DROP CONSTRAINT "payment_cancel_fail_reason_check";--> statement-breakpoint
ALTER TABLE "partner_receivable" DROP CONSTRAINT "partner_receivable_pg_check";--> statement-breakpoint
ALTER TABLE "partner_receivable" ALTER COLUMN "pg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_transfer_compensation_id_key" ON "compensation_transfer" USING btree ("compensation_id");--> statement-breakpoint
CREATE INDEX "compensation_transfer_status_idx" ON "compensation_transfer" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_receivable_source_ref_uidx" ON "partner_receivable" USING btree ("source_ref") WHERE "partner_receivable"."source_ref" is not null;--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD CONSTRAINT "payment_cancel_attempt_check" CHECK ("payment_cancel"."attempt" >= 0 AND "payment_cancel"."attempt" <= 3);--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD CONSTRAINT "payment_cancel_fail_reason_check" CHECK ("payment_cancel"."fail_reason" IS NULL OR ("payment_cancel"."status" = 'FAILED' AND "payment_cancel"."fail_reason" IN ('REFUND_ACCOUNT_INVALID', 'SUPERSEDED')));--> statement-breakpoint
ALTER TABLE "partner_receivable" ADD CONSTRAINT "partner_receivable_pg_check" CHECK ("partner_receivable"."pg" is null or "partner_receivable"."pg" in ('TOSS', 'PORTONE'));