-- 회차 취소·연기 일괄 환불의 정산 알리기 보낸 시각과 배상 송금 결과 확정 인덱스(F-07-8 I-01·I-04·I-06, ADR-0380 결정 1~3, docs/data.md event_cancellation_request·compensation).
-- 표 정의는 src/modules/refund/adapters/db/schema.ts이고 db:generate로 만든 뒤 감독이 준 번호 0038로 옮겼다(스냅샷 meta/0038_snapshot.json).
-- settlement_hold_sent_at·settlement_completion_sent_at·settlement_next_at은 payment-svc 다시 계산 내부 HTTP(보류 열기·완료)를 받은 시각과 다시 부를 시각이고,
-- settlement_notice_failures는 잇따른 실패 수(1분 → 5분 → 15분, 그 뒤 15분마다 [가정]의 간격을 고른다)다.
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다(docs/devops.md §7.2).
ALTER TABLE "event_cancellation_request" ADD COLUMN "settlement_hold_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD COLUMN "settlement_completion_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD COLUMN "settlement_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD COLUMN "settlement_notice_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "compensation_requested_idx" ON "compensation" USING btree ("status") WHERE "compensation"."status" = 'REQUESTED';--> statement-breakpoint
CREATE INDEX "event_cancellation_settlement_due_idx" ON "event_cancellation_request" USING btree ("settlement_next_at") WHERE "event_cancellation_request"."settlement_completion_sent_at" is null;--> statement-breakpoint
ALTER TABLE "event_cancellation_request" ADD CONSTRAINT "event_cancellation_settlement_failures_check" CHECK ("event_cancellation_request"."settlement_notice_failures" >= 0);--> statement-breakpoint
-- 이 칸이 생기기 전에 끝난 요청(COMPLETED·REJECTED)은 정산에 다시 알리지 않는다(알리기는 이 칸이 생긴 뒤 확정한 요청부터다)
UPDATE "event_cancellation_request" SET "settlement_completion_sent_at" = "updated_at" WHERE "status" IN ('COMPLETED', 'REJECTED');
