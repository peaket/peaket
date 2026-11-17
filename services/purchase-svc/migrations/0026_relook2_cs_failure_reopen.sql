-- 다시 보기 2 N2(BUILD_ORDER GAT-090·GAT-110, BAT-420 보충 5, docs/data.md order_cancellation·event_refund_item, docs/features/transfer-refund.md §3.1 ⑥).
-- order_cancellation: 환급 실패 CS 건을 ops-svc가 2xx로 받은 시각(refund_failed_opened_at). 회차 취소 요청 ID가 없는 실패 표시 행만 마감 뒤 환급 실행기 틱 끝에 다시 연다.
-- event_refund_item: 일괄 환불 실패 CS 건을 열 대상으로 정한 시각(failure_case_at, 항목을 FAILED로 끝내는 쓰기와 같은 트랜잭션)과 연 시각(failure_case_opened_at,
-- 열 대상 표시 없이 쓰지 않는다). 열지 않은 건은 일괄 환불 실행기 틱 끝에 다시 연다(부분 색인 둘이 그 목록을 받친다).
-- 모두 빈 값 허용이고 옛 행은 채우지 않는다(운영 데이터가 없다. 이 마이그레이션 전에 실패 표시된 행은 배포 뒤 한 번 다시 보낸다, 같은 eventKey라 한 건).
ALTER TABLE "order_cancellation" ADD COLUMN "refund_failed_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "failure_case_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD COLUMN "failure_case_opened_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_cancellation_refund_failed_open_idx" ON "order_cancellation" USING btree ("refund_failed_at") WHERE "order_cancellation"."refund_failed_at" is not null and "order_cancellation"."refund_failed_opened_at" is null and "order_cancellation"."event_cancellation_request_id" is null;--> statement-breakpoint
CREATE INDEX "event_refund_item_failure_case_open_idx" ON "event_refund_item" USING btree ("failure_case_at") WHERE "event_refund_item"."failure_case_at" is not null and "event_refund_item"."failure_case_opened_at" is null;--> statement-breakpoint
ALTER TABLE "event_refund_item" ADD CONSTRAINT "event_refund_item_failure_case_check" CHECK ("event_refund_item"."failure_case_opened_at" is null or "event_refund_item"."failure_case_at" is not null);