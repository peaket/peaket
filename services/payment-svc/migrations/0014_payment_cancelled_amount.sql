-- 결제 후 일반 취소(부분·전액)의 취소 누적액(판매 승인 LCH-080·GAT-080, docs/features/payment.md §4.1).
-- 입금 전 취소는 원장을 FAILED로 끝내므로 이 칸을 쓰지 않는다. 일반 취소는 APPROVED·PARTIAL_CANCELED에서
-- 결제사 부분 취소를 부르고, 성공한 금액을 여기에 더한다. 남은 취소 가능액 = amount - cancelled_amount다.
ALTER TABLE "payment" ADD COLUMN "cancelled_amount" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_cancelled_amount_check" CHECK ("payment"."cancelled_amount" >= 0 AND "payment"."cancelled_amount" <= "payment"."amount");
