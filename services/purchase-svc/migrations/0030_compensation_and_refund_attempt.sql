-- 배상 기록과 지연 환급 계좌 다시 받기(BAT-425 GAT-120·GAT-130, ADR-0316·0317, purchase 0030, docs/data.md order_cancellation·compensation).
-- order_cancellation: 같은 취소 ID의 환급 시도 번호(refund_attempt, 0~3 [가정]). 0은 첫 시도(cancel-{id}), 1~3은 계좌를 다시 받은 시도(cancel-{id}-a{n})다.
-- compensation: 회차 취소 확정이 주최 측 귀책·공연 내용 변경일 때 대상 주문마다 한 행((request_id, order_id) 유일).
-- 금액은 그 주문의 대상 표 권면 합의 10%를 원 미만 올림해 한 번만 계산해 저장하고, 계좌번호 원문은 저장하지 않는다(끝 4자리만, POL-014).
CREATE TABLE "compensation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_cancellation_request_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"promoter_id" uuid,
	"base_amount" integer NOT NULL,
	"amount" integer NOT NULL,
	"status" text NOT NULL,
	"account_last4" text,
	"transfer_id" text,
	"receivable_id" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "compensation_status_check" CHECK ("compensation"."status" in ('ACCOUNT_PENDING', 'REQUESTED', 'PAID', 'FAILED')),
	CONSTRAINT "compensation_amounts_check" CHECK ("compensation"."base_amount" >= 0 and "compensation"."amount" >= 0),
	CONSTRAINT "compensation_account_last4_check" CHECK ("compensation"."account_last4" is null or "compensation"."account_last4" ~ '^[0-9]{1,4}$'),
	CONSTRAINT "compensation_transfer_check" CHECK ("compensation"."status" <> 'ACCOUNT_PENDING' or "compensation"."transfer_id" is null),
	CONSTRAINT "compensation_receivable_check" CHECK ("compensation"."receivable_id" is null or "compensation"."status" = 'PAID')
);
--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_request_order_key" ON "compensation" USING btree ("event_cancellation_request_id","order_id");--> statement-breakpoint
CREATE INDEX "compensation_account_created_idx" ON "compensation" USING btree ("account_id","created_at","id");--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_refund_attempt_check" CHECK ("order_cancellation"."refund_attempt" >= 0 and "order_cancellation"."refund_attempt" <= 3);