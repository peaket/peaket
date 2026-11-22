-- 보상 세 걸음의 상태 표(BAT-011, PRF-173, ADR-0354 결정 3, docs/data.md §2 order_compensation·§5.1).
-- 회차 취소가 확정됐는데 발권이 아직 끝나지 않은(APPROVED) 주문마다 한 행이다. 주문 상태에 COMPENSATING을 더하지 않고 이 표가
-- STARTED·FENCED(보상 중)를 든다. 주문은 결제 취소가 끝난 뒤 T20으로 한 번만 COMPENSATED가 되고, 그때 이 행도 COMPENSATED가 된다(compCancel).
-- next_attempt_at은 다시 보낼 때의 다음 시각(다시 보내지 않으면 비운다). lease_until은 실행기가 잡은 동안의 임대 끝이다.
-- canceled_at은 보상 완료(결제 취소·T20) 시각이다. 행은 끝(COMPENSATED·FAILED)난 뒤에도 감사 기록으로 남기고, 주문 기록과 함께 보존한다(정리 작업 없음).
CREATE TABLE "order_compensation" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"payment_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"fenced_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "order_compensation_status_check" CHECK ("order_compensation"."status" in ('STARTED', 'FENCED', 'COMPENSATED', 'FAILED')),
	CONSTRAINT "order_compensation_attempts_check" CHECK ("order_compensation"."attempts" >= 0),
	CONSTRAINT "order_compensation_reason_check" CHECK (length("order_compensation"."reason") > 0)
);
--> statement-breakpoint
ALTER TABLE "order_compensation" ADD CONSTRAINT "order_compensation_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_compensation_next_attempt_idx" ON "order_compensation" USING btree ("next_attempt_at") WHERE "order_compensation"."status" in ('STARTED', 'FENCED');