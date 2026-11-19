-- 굿즈 취소·반품의 인덱스 보강(BUILD_ORDER LCH-030, BAT-605, ADR-0314·0315).
-- 입금 기한 + 10분 만료 작업이 AWAITING_DEPOSIT 행만 기한 차례로 읽고, 반품 처리 지연 감시가 RETURN_REQUESTED 행만 읽는다.
-- 0030에 합쳐도 되는 선택 마이그레이션이다(계획 §4).
CREATE INDEX "merch_order_deposit_due_idx" ON "merch_order" USING btree ("stock_reserved_until") WHERE "merch_order"."status" = 'AWAITING_DEPOSIT';--> statement-breakpoint
CREATE INDEX "merch_order_item_return_idx" ON "merch_order_item" USING btree ("return_requested_at") WHERE "merch_order_item"."status" = 'RETURN_REQUESTED';
