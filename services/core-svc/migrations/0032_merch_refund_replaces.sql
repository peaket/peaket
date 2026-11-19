-- 굿즈 지연 환급 계좌 다시 받기(BUILD_ORDER GAT-130, BAT-425, ADR-0316 결정 5, docs/data.md `merch_refund`).
-- 옛 `merch_refund` 행(REJECTED·REFUND_ACCOUNT_REQUIRED)은 그대로 두고, 계좌를 다시 받은 새 행이 `replaces_refund_id`로 옛 행을 가리킨다.
-- 옛 행 하나는 새 행 하나로만 대신한다(부분 유일 인덱스). 새 취소 ID가 결제사 멱등키(cancel-{ID}-a{n})의 기준이다.
-- 멱등 작업 목록에 SHOP_CANCEL_REFUND_ACCOUNT를 더한다(0030이 손으로 더한 CANCEL_MERCH_ORDER·RETURN_MERCH_ORDER도 스키마와 맞춘다).
-- 계좌 값은 어느 칸에도 두지 않는다(POL-014).
ALTER TABLE "merch_refund" ADD COLUMN "replaces_refund_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_operation_check";--> statement-breakpoint
ALTER TABLE "merch_refund" ADD CONSTRAINT "merch_refund_replaces_refund_id_merch_refund_id_fk" FOREIGN KEY ("replaces_refund_id") REFERENCES "public"."merch_refund"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merch_refund_replaces_uq" ON "merch_refund" USING btree ("replaces_refund_id") WHERE "merch_refund"."replaces_refund_id" is not null;--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_operation_check" CHECK ("idempotency_record"."operation" in ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT', 'CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER', 'SHOP_CANCEL_REFUND_ACCOUNT'));--> statement-breakpoint
ALTER TABLE "merch_refund" ADD CONSTRAINT "merch_refund_replaces_check" CHECK ("merch_refund"."replaces_refund_id" is null or "merch_refund"."replaces_refund_id" <> "merch_refund"."id");
