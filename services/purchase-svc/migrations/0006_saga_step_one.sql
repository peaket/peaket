-- Saga 1단계의 저장 자리(docs/data.md §2 purchase_order.failure_reason·§4 일곱 번째 마이그레이션, docs/features/payment.md §2 'Saga 1단계의 첫 구현', BUILD_ORDER PRF-165).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- purchase_order.failure_reason은 FAILED일 때만 채워 널을 허용하고, 값 목록이 결제 쪽 사유(PRF-163)로 늘어나므로 CHECK를 두지 않는다.
-- order_saga_job.confirm_sent_at은 승인 명령을 처음 보내기 바로 전에 적는 시각이다(널 허용. 있으면 purchase는 혼자 T11을 하지 않는다, 2026-11-05 리뷰 H1).
-- order_saga_job.step은 RESERVE·CONFIRM·RELEASE 셋만 받는다(0005에서 미룬 CHECK, RELEASE는 실패 해제 다시 하기, 2026-11-05 리뷰 M4).
-- 0005 접수가 넣은 행은 모두 RESERVE라 제약을 더해도 어긋나는 행이 없다.
ALTER TABLE "order_saga_job" ADD COLUMN "confirm_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "order_saga_job" ADD CONSTRAINT "order_saga_job_step_check" CHECK ("order_saga_job"."step" in ('RESERVE', 'CONFIRM', 'RELEASE'));
