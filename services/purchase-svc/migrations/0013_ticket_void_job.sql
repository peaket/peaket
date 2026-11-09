-- 티켓 무효 큐와 발권 세대(docs/data.md §2 ERD ticket_void_job·§4 '입금 오류 되돌림과 입금 전 취소', docs/features/payment.md §6, BUILD_ORDER HOT-152).
-- issue_generation의 기본값 0은 세대를 적지 않은 행이다. 표가 아직 배포되지 않아 인덱스를 CONCURRENTLY로 만들지 않는다.
CREATE TABLE "ticket_void_job" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"issue_generation" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_issue_job" ADD COLUMN "issue_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ticket_void_job" ADD CONSTRAINT "ticket_void_job_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_void_job_next_attempt_idx" ON "ticket_void_job" USING btree ("next_attempt_at");