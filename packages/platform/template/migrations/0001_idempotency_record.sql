-- 서비스마다 둔 멱등 기록 표(docs/data.md '서비스마다 둔 멱등 기록 표', ADR-0146 결정 1, docs/api/guidelines.md §4).
-- 표 정의는 @peaket/platform의 idempotencyRecordTable(작업 목록)이고 drizzle-kit generate가 만든 모양이다. operation CHECK는 그 서비스 작업 목록이다.
-- 키 행은 업무 쓰기와 같은 트랜잭션에 넣고(IdempotencyStore.run), 24시간 [가정] 지난 행은 정비 시간에 created_at 순으로 나눠 지운다.
CREATE TABLE "idempotency_record" (
	"account_ref" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" bytea NOT NULL,
	"result_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_account_ref_operation_idempotency_key_pk" PRIMARY KEY("account_ref","operation","idempotency_key"),
	CONSTRAINT "idempotency_record_operation_check" CHECK ("idempotency_record"."operation" in ('CREATE_NOTE'))
);
CREATE INDEX "idempotency_record_created_at_idx" ON "idempotency_record" USING btree ("created_at");
