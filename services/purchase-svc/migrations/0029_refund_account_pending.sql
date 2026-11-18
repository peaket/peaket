-- 가상계좌 환불 계좌 전달(BUILD_ORDER GAT-090, BAT-420-rest, docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현', docs/data.md order_cancellation·event_refund_item).
-- order_cancellation: payment-svc가 REFUND_ACCOUNT_REQUIRED로 답한 시각(refund_account_required_at, 계좌 대기 표시)과 CS '환불 대기'(REFUND_ACCOUNT_PENDING) 건을
-- ops-svc가 2xx로 받은 시각(refund_account_case_opened_at, 표시 없이 쓰지 않는다). 열지 않은 건은 마감 뒤 환급 실행기 틱 끝에 다시 연다(부분 색인이 그 목록을 받친다).
-- event_refund_item: 회차 취소 일괄 환불의 가상계좌 항목 상태 ACCOUNT_PENDING. 계좌는 어디에도 저장하지 않는다. 모두 빈 값 허용이고 옛 행은 채우지 않는다.
ALTER TABLE "event_refund_item" DROP CONSTRAINT "event_refund_item_status_check";--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_account_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD COLUMN "refund_account_case_opened_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_cancellation_refund_account_open_idx" ON "order_cancellation" USING btree ("refund_account_required_at") WHERE "order_cancellation"."refund_account_required_at" is not null and "order_cancellation"."refund_account_case_opened_at" is null;--> statement-breakpoint
ALTER TABLE "order_cancellation" ADD CONSTRAINT "order_cancellation_refund_account_case_check" CHECK ("order_cancellation"."refund_account_case_opened_at" is null or "order_cancellation"."refund_account_required_at" is not null);--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD CONSTRAINT "event_refund_item_status_check" CHECK ("event_refund_item"."status" in ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN', 'NOT_APPLIED', 'ACCOUNT_PENDING'));