-- 발권 재시도 큐(docs/data.md §2 ERD ticket_issue_job·§4 여덟 번째 마이그레이션, docs/features/payment.md §2 '결제 결과 반영의 첫 구현', BUILD_ORDER PRF-163, ADR-0106).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- 결제 승인을 반영하는 트랜잭션이 한 행을 넣고, 발권(CONFIRMED)·보상(COMPENSATED)과 같은 트랜잭션에서 지운다. 발권 호출·다시 하기는 PRF-170이다.
-- next_attempt_at은 다시 보내도 결과가 같은 오류면 비워 자동 재시도를 멈추므로 널을 허용한다. 쓸기 색인은 (next_attempt_at)이다.
-- purchase_order.failure_reason에는 결제 쪽 사유(사건의 failureCategory)가 들어온다(칸은 0006 그대로, CHECK 없음).
CREATE TABLE "ticket_issue_job" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"issue_due_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_issue_job" ADD CONSTRAINT "ticket_issue_job_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_issue_job_next_attempt_idx" ON "ticket_issue_job" USING btree ("next_attempt_at");