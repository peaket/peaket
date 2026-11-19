-- 굿즈·부가 상품 구매자 취소와 반품(BUILD_ORDER LCH-030, BAT-605, ADR-0315, POL-016 §1.4, docs/data.md §2 merch_order_item·merch_refund·merch_refund_item).
-- 감독 배정 번호 0030(core-svc 0030~0031, docs/lanes/coord.md). drizzle-kit generate로 만든 뒤 멱등 작업 목록·권한을 손으로 더했다.
-- merch_order_item: 판매자 송장(tracking_no)·반품 사유(CHECK 두 값)·반품 송장·도착 확인·거절 사유·정산 기준일·정산서.
-- merch_refund: kind(UNCLAIMED·USER_CANCEL·RETURN), 다시 부른 횟수, 값 없는 실패 이름표, 계좌 대기 시각.
-- merch_refund_item: 항목 하나에 진행 중 환급 하나를 부분 유일 인덱스(resolved_at is null)로 보장한다(ADR-0315).
-- 취소 사유 CHECK는 구매자 취소(USER_CANCEL)를 더한다. 계좌 값은 어느 표에도 두지 않는다(POL-014).
CREATE TABLE "merch_refund_item" (
	"refund_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "merch_order_item" DROP CONSTRAINT "merch_order_item_cancel_reason_check";--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "tracking_no" text;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "return_reason" text;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "return_tracking_no" text;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "return_received_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "settle_eligible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD COLUMN "statement_id" uuid;--> statement-breakpoint
ALTER TABLE "merch_refund" ADD COLUMN "kind" text DEFAULT 'UNCLAIMED' NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_refund" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_refund" ADD COLUMN "fail_reason" text;--> statement-breakpoint
ALTER TABLE "merch_refund" ADD COLUMN "account_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merch_refund_item" ADD CONSTRAINT "merch_refund_item_refund_id_merch_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."merch_refund"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_refund_item" ADD CONSTRAINT "merch_refund_item_item_id_merch_order_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."merch_order_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merch_refund_item_active_uq" ON "merch_refund_item" USING btree ("item_id") WHERE "merch_refund_item"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "merch_refund_item_refund_idx" ON "merch_refund_item" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "merch_refund_kind_due_idx" ON "merch_refund" USING btree ("kind","next_at") WHERE "merch_refund"."status" in ('REQUESTED', 'CANCEL_PENDING');--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD CONSTRAINT "merch_order_item_return_reason_check" CHECK ("merch_order_item"."return_reason" in ('CHANGE_OF_MIND', 'DEFECT_OR_MISMATCH'));--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD CONSTRAINT "merch_order_item_cancel_reason_check" CHECK ("merch_order_item"."cancel_reason" in ('UNCLAIMED', 'USER_CANCEL'));--> statement-breakpoint
ALTER TABLE "merch_refund" ADD CONSTRAINT "merch_refund_kind_check" CHECK ("merch_refund"."kind" in ('UNCLAIMED', 'USER_CANCEL', 'RETURN'));--> statement-breakpoint
ALTER TABLE "merch_refund" ADD CONSTRAINT "merch_refund_attempts_check" CHECK ("merch_refund"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "idempotency_record" DROP CONSTRAINT "idempotency_record_operation_check";--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_operation_check" CHECK ("idempotency_record"."operation" in ('CREATE_PRODUCTION', 'CREATE_PRODUCTION_EVENT', 'CREATE_MERCH_ORDER', 'START_MERCH_PAYMENT', 'ACCEPT_MERCH_PAYMENT', 'CREATE_TICKET_ADDON', 'CANCEL_MERCH_ORDER', 'RETURN_MERCH_ORDER'));--> statement-breakpoint
-- 새 표는 core_app만 읽고 쓴다(core_partner는 읽지 않는다). 계좌 값이 없어 암호화할 칸도 없다(POL-014, ADR-0050 결정 3)
GRANT SELECT, INSERT, UPDATE, DELETE ON merch_refund_item TO core_app;
