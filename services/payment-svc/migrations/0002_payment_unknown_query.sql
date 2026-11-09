-- UNKNOWN 조회 칸 넷과 잡기·1시간 표시 부분 인덱스, 다음 조회 시각 CHECK(docs/data.md §2 payment·§4 '결제 표 마이그레이션'·§5.1, docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현', BUILD_ORDER PRF-182).
-- next_query_at은 UNKNOWN일 때만 채운다. 끝난 행은 인덱스에 들어가지 않는다.
-- payment 표는 아직 배포된 적이 없어 행이 없다. 그래서 기존 UNKNOWN 행의 next_query_at을 채우는 문장이 없다.
ALTER TABLE "payment" ADD COLUMN "next_query_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "query_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "anomaly_logged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_unknown_next_query_check" CHECK ("payment"."status" <> 'UNKNOWN' OR "payment"."next_query_at" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "payment_unknown_query_idx" ON "payment" USING btree ("next_query_at") WHERE "payment"."status" = 'UNKNOWN';--> statement-breakpoint
CREATE INDEX "payment_unknown_status_changed_idx" ON "payment" USING btree ("status_changed_at") WHERE "payment"."status" = 'UNKNOWN';
