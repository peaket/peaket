-- 굿즈 결제의 원장 길(ADR-0299 결정 1, BUILD_ORDER LCH-010, BAT-600). 결제 원장에 주문 종류(TICKET 예매·MERCH 굿즈와 티켓 연동 부가 상품)를 두고,
-- 굿즈는 회차 칸을 비운다. 회차 정산서의 결제 읽기(event_id = $1)에 굿즈가 걸리지 않는다. 있는 행은 모두 TICKET이다(기본값).
ALTER TABLE "payment" ALTER COLUMN "event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "order_kind" text DEFAULT 'TICKET' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_order_kind_check" CHECK ("payment"."order_kind" IN ('TICKET', 'MERCH'));--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_order_kind_event_check" CHECK (("payment"."order_kind" = 'TICKET') = ("payment"."event_id" IS NOT NULL));
