-- 웨이브 끝 리뷰 K2·C2·S1(BUILD_ORDER GAT-090·GAT-110, BAT-420 보충 4, docs/data.md order_cancellation·event_refund_item, docs/features/transfer-refund.md §3.1 ②·§5).
-- order_cancellation: 이상 표시 건을 연 시각(entry_flag_opened_at), 공제 차액 대상 표시(deduction_gap_at·deduction_gap_request_id, 함께 있거나 함께 없다)와
-- 차액 건을 연 시각(deduction_gap_opened_at). 열지 않은 건은 실행기 틱이 다시 연다(부분 색인 둘이 그 목록을 받친다).
-- event_refund_item: 주문 단위 잡기 값(claim_token)과 기한(claimed_until, 함께 있거나 함께 없다). 모두 빈 값 허용이고 기존 행은 NULL이다.
ALTER TABLE "order_cancellation" ADD COLUMN "entry_flag_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "deduction_gap_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "deduction_gap_request_id" uuid;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "deduction_gap_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_cancellation_entry_flag_open_idx" ON "order_cancellation" USING btree ("entry_recorded_at") WHERE "order_cancellation"."entry_recorded_at" is not null and "order_cancellation"."entry_flag_opened_at" is null;--> statement-breakpoint
CREATE INDEX "order_cancellation_deduction_gap_open_idx" ON "order_cancellation" USING btree ("deduction_gap_at") WHERE "order_cancellation"."deduction_gap_at" is not null and "order_cancellation"."deduction_gap_opened_at" is null;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_deduction_gap_check" CHECK (("order_cancellation"."deduction_gap_at" is null) = ("order_cancellation"."deduction_gap_request_id" is null));--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD CONSTRAINT "event_refund_item_claim_check" CHECK (("event_refund_item"."claim_token" is null) = ("event_refund_item"."claimed_until" is null));