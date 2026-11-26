-- F-06-8 예매 확정 알림의 예매번호(ADR-0388, docs/data.md purchase_order·booking_no_sequence).
-- 한국 시각 날짜 8자리 + 5자리 일련번호. 주문 생성 트랜잭션의 INSERT … ON CONFLICT로 잡고, 99,999를 넘으면 주문을 닫는다.
-- 기존 주문은 번호가 없으므로 nullable로 더한다(UNIQUE는 null 여러 행을 허용한다). 새 주문은 CreateOrder가 채운다.
CREATE TABLE "booking_no_sequence" (
  "day" date PRIMARY KEY NOT NULL,
  "next" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "booking_no" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_booking_no_key" ON "purchase_order" USING btree ("booking_no");
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_booking_no_check"
  CHECK ("booking_no" IS NULL OR ("booking_no" ~ '^[0-9]{13}$' AND substring("booking_no", 9, 5) <> '00000'));
