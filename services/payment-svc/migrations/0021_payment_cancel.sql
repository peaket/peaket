-- 결제 후 일반 취소 한 건(payment_cancel, BUILD_ORDER GAT-080·HOT-140이 넘긴 것, docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', docs/data.md payment_cancel).
-- 첫 전송 직전에 결제 행 잠금 안에서 금액·사유·전액 여부·기대 잔액(결제 금액 - 누적 취소액)을 적고, 재시도는 그 값을 그대로 보낸다.
-- 끝남은 그 행의 CANCELED로만 가른다. 진행 중(REQUESTED·CANCEL_PENDING) 행이 10분 [가정] 안이면 같은 결제의 다른 취소를 보내지 않는다(부분 인덱스로 찾는다).
CREATE TABLE "payment_cancel" (
	"id" uuid PRIMARY KEY NOT NULL,
	"payment_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"full_cancel" boolean NOT NULL,
	"expected_balance" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"canceled_at" timestamp with time zone,
	CONSTRAINT "payment_cancel_amount_check" CHECK ("payment_cancel"."amount" > 0),
	CONSTRAINT "payment_cancel_expected_balance_check" CHECK ("payment_cancel"."expected_balance" >= "payment_cancel"."amount"),
	CONSTRAINT "payment_cancel_status_check" CHECK ("payment_cancel"."status" IN ('REQUESTED', 'CANCEL_PENDING', 'CANCELED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "payment_cancel" ADD CONSTRAINT "payment_cancel_payment_id_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_cancel_payment_idempotency_key" ON "payment_cancel" USING btree ("payment_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_cancel_in_progress_idx" ON "payment_cancel" USING btree ("payment_id") WHERE "payment_cancel"."status" IN ('REQUESTED', 'CANCEL_PENDING');