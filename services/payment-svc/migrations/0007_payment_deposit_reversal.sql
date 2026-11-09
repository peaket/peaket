-- 입금 오류 되돌림과 입금 전 취소의 칸(docs/data.md §4 '입금 오류 되돌림과 입금 전 취소', docs/features/payment.md §6, BUILD_ORDER HOT-152).
-- 단독 조회 잡기의 부분 인덱스에 되돌림 확인을 건 APPROVED 행을 넣고, 실패 범주에 입금 전 취소를 더한다. payment 표는 아직 배포된 적이 없어 인덱스를 CONCURRENTLY로 만들지 않는다.
ALTER TABLE "payment" DROP CONSTRAINT "payment_failure_category_check";--> statement-breakpoint
DROP INDEX "payment_query_due_idx";--> statement-breakpoint
CREATE INDEX "payment_query_due_idx" ON "payment" USING btree ("next_query_at") WHERE "payment"."status" IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR ("payment"."status" IN ('FAILED', 'APPROVED') AND "payment"."next_query_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_failure_category_check" CHECK ("payment"."failure_category" IN ('CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED', 'DEPOSIT_CANCELED'));