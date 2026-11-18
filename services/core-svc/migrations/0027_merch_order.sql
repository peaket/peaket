-- 굿즈 주문·결제 시도·승인 명령 작업·환급(BUILD_ORDER LCH-010·LCH-020, BAT-600, ADR-0300 결정 4~9, ADR-0301 결정 2·5, docs/data.md §2 merch_order·merch_order_item).
-- 감독 배정 번호 0027(core-svc 0027~0028이 갈래 5 몫, docs/lanes/coord.md). drizzle-kit generate로 만든 뒤 자료 옮기기·권한을 손으로 더했다.
-- merch_order.status를 정본 값(CREATED·AWAITING_DEPOSIT·PAID·EXPIRED·FAILED)으로 바꾸고 BAT-610 코드에만 있던 값을 옮긴다(PENDING → CREATED, CANCELLED·REFUNDED → PAID.
-- 취소·환급은 이미 항목 상태에 있다). buyer_name·buyer_phone은 NULL 허용(새 주문은 채우지 않는다). 새 표는 core_app만 쓰고 읽는다(core_partner는 읽지 않는다).
CREATE TABLE "merch_confirm_job" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"pg" text NOT NULL,
	"payment_ref" jsonb NOT NULL,
	"amount" integer NOT NULL,
	"authenticated_at" timestamp with time zone NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merch_payment_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"pg" text NOT NULL,
	"pay_method" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "merch_payment_attempt_status_check" CHECK ("merch_payment_attempt"."status" in ('READY', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED', 'FAILED')),
	CONSTRAINT "merch_payment_attempt_pg_check" CHECK ("merch_payment_attempt"."pg" in ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "merch_payment_attempt_no_check" CHECK ("merch_payment_attempt"."attempt_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "merch_refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"item_ids" uuid[] NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"next_at" timestamp with time zone,
	"alerted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merch_refund_status_check" CHECK ("merch_refund"."status" in ('REQUESTED', 'CANCEL_PENDING', 'CANCELLED', 'REJECTED')),
	CONSTRAINT "merch_refund_amount_check" CHECK ("merch_refund"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_operation_check";--> statement-breakpoint
ALTER TABLE "merch_order" DROP CONSTRAINT "merch_order_status_check";--> statement-breakpoint
UPDATE "merch_order" SET "status" = 'CREATED' WHERE "status" = 'PENDING';--> statement-breakpoint
UPDATE "merch_order" SET "status" = 'PAID' WHERE "status" IN ('CANCELLED', 'REFUNDED');--> statement-breakpoint
ALTER TABLE "merch_order" DROP CONSTRAINT "merch_order_pg_check";--> statement-breakpoint
ALTER TABLE "merch_order" ALTER COLUMN "buyer_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_order" ALTER COLUMN "buyer_phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_order" ALTER COLUMN "status" SET DEFAULT 'CREATED';--> statement-breakpoint
ALTER TABLE "merch_order" ALTER COLUMN "pg" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "fulfillment" text;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "amount" integer;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "stock_reserved_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "escrow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "consent_version" text;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "recipient_phone" text;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "pickup_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "merch_order" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "option_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "linked_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "merch_confirm_job" ADD CONSTRAINT "merch_confirm_job_order_id_merch_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merch_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_payment_attempt" ADD CONSTRAINT "merch_payment_attempt_order_id_merch_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merch_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_refund" ADD CONSTRAINT "merch_refund_order_id_merch_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merch_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merch_confirm_job_next_idx" ON "merch_confirm_job" USING btree ("next_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merch_payment_attempt_order_no_uq" ON "merch_payment_attempt" USING btree ("order_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "merch_payment_attempt_ready_uq" ON "merch_payment_attempt" USING btree ("order_id") WHERE "merch_payment_attempt"."status" = 'READY';--> statement-breakpoint
CREATE UNIQUE INDEX "merch_payment_attempt_accepted_uq" ON "merch_payment_attempt" USING btree ("order_id") WHERE "merch_payment_attempt"."status" = 'ACCEPTED';--> statement-breakpoint
CREATE INDEX "merch_refund_due_idx" ON "merch_refund" USING btree ("next_at") WHERE "merch_refund"."status" in ('REQUESTED', 'CANCEL_PENDING');--> statement-breakpoint
CREATE INDEX "merch_refund_order_idx" ON "merch_refund" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "merch_order_reserved_idx" ON "merch_order" USING btree ("stock_reserved_until") WHERE "merch_order"."status" = 'CREATED';--> statement-breakpoint
CREATE INDEX "merch_order_account_idx" ON "merch_order" USING btree ("account_id","ordered_at","id");--> statement-breakpoint
CREATE INDEX "merch_order_item_linked_ticket_idx" ON "merch_order_item" USING btree ("linked_ticket_id");--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_operation_check" CHECK ("idempotency_record"."operation" in ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT', 'CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON'));--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_fulfillment_check" CHECK ("merch_order"."fulfillment" in ('DELIVERY', 'PICKUP', 'WALLET'));--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_amount_check" CHECK ("merch_order"."amount" >= 0);--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_status_check" CHECK ("merch_order"."status" in ('CREATED', 'AWAITING_DEPOSIT', 'PAID', 'EXPIRED', 'FAILED'));--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_pg_check" CHECK ("merch_order"."pg" in ('TOSS', 'PORTONE', 'SIMULATOR'));--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD CONSTRAINT "merch_order_item_cancel_reason_check" CHECK ("merch_order_item"."cancel_reason" in ('UNCLAIMED'));--> statement-breakpoint
-- 권한: 새 표 셋은 core_app만(기본 권한으로 SELECT는 이미 있다). 결제 접수의 조건부 차감과 결과 반영의 되돌림이 product_stock을 고친다(docs/data.md §4 경계 5).
-- 굿즈 주문의 멱등 기록은 core_app이 쓴다(core_partner는 0004에서 이미 쓴다)
GRANT SELECT, INSERT, UPDATE, DELETE ON merch_payment_attempt, merch_confirm_job, merch_refund TO core_app;--> statement-breakpoint
GRANT UPDATE ON product_stock TO core_app;--> statement-breakpoint
CREATE POLICY product_stock_app_update ON product_stock FOR UPDATE TO core_app USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON idempotency_record TO core_app;
