-- 결제 접수의 저장 자리(docs/data.md §2 payment_attempt·purchase_order·§4 여섯 번째 마이그레이션·§5 '결제 접수', docs/features/payment.md §2 '결제 접수의 첫 구현', BUILD_ORDER PRF-162).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/booking/adapters/db/schema.ts).
-- payment_attempt의 결제 참조 칸 다섯(결제 키·포트원 거래 ID·포트원 토큰·인증 시각·접수 시각)과 purchase_order.seat_gen은 접수 전에 비어 있어 널을 허용한다.
-- order_saga_job은 주문 ID 기본 키라 한 주문에 작업 행이 하나다. step 값 CHECK는 두지 않는다(값 목록은 Saga 실행기를 만드는 PRF-165가 정한다).
CREATE TABLE "order_saga_job" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"step" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "pg_payment_key" text;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "pg_tx_id" text;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "pg_payment_token" text;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "authenticated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_attempt" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "seat_gen" integer;--> statement-breakpoint
ALTER TABLE "order_saga_job" ADD CONSTRAINT "order_saga_job_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_saga_job_next_attempt_idx" ON "order_saga_job" USING btree ("next_attempt_at");