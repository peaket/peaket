-- 단독 조회 잡기를 입금 대기까지 넓힌다(docs/data.md §2 payment·§4 '단독 조회 잡기 넓히기'·§5.1, docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151).
-- next_query_at은 UNKNOWN과 AWAITING_DEPOSIT 둘 다에 쓰이고, 늦은 입금 확인을 건 FAILED 행에도 잠깐 쓰인다. 그 밖의 끝난 행은 인덱스에 들어가지 않는다. 가상계좌 칸은 0000에 이미 있다.
-- deposit_notified_at은 입금 완료 통보를 처음 받은 시각이다(짧은 간격 조회의 기준, FAILED 행에서는 늦은 입금 확인을 건 표시).
-- payment 표는 아직 배포된 적이 없어 행이 없다. 그래서 기존 행을 채우는 문장이 없고 인덱스를 CONCURRENTLY로 만들지 않는다.
ALTER TABLE "payment" DROP CONSTRAINT "payment_unknown_next_query_check";--> statement-breakpoint
DROP INDEX "payment_unknown_query_idx";--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "deposit_notified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_query_due_idx" ON "payment" USING btree ("next_query_at") WHERE "payment"."status" IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR ("payment"."status" = 'FAILED' AND "payment"."next_query_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_next_query_check" CHECK ("payment"."status" NOT IN ('UNKNOWN', 'AWAITING_DEPOSIT') OR "payment"."next_query_at" IS NOT NULL);
