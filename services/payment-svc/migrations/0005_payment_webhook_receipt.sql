-- 웹훅 수신 기록과 참조로 원장 찾는 인덱스를 더한다(docs/data.md §2 webhook_receipt·§4 '웹훅 수신 기록'·§5·§5.1, docs/features/payment.md §5 '웹훅 받기의 첫 구현', BUILD_ORDER HOT-150).
-- 웹훅은 승인 명령보다 먼저 올 수 있어 payment_id에 외래 키를 걸지 않는다. 표가 아직 배포되지 않아 행이 없으므로 인덱스를 CONCURRENTLY로 만들지 않는다.
-- payment.query_touched_at은 조회 신호의 결제별 최소 간격을 재는 칸이다(비울 수 있고 기본값이 없어 표를 다시 쓰지 않는다).
CREATE TABLE "webhook_receipt" (
	"pg" text NOT NULL,
	"dedup_key" text NOT NULL,
	"payment_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webhook_receipt_pg_dedup_key_pk" PRIMARY KEY("pg","dedup_key"),
	CONSTRAINT "webhook_receipt_pg_check" CHECK ("webhook_receipt"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR'))
);
--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "query_touched_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_receipt_received_at_idx" ON "webhook_receipt" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "payment_pg_ref_idx" ON "payment" USING btree ("pg","pg_payment_ref");