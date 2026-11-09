-- 실패 범주 칸(docs/data.md §2 payment.failure_category·§4 '결제 표 마이그레이션', docs/features/payment.md §2 '승인 실행기의 첫 구현', BUILD_ORDER PRF-181).
-- 값은 분석용 실패 범주 여섯(proto FailureCategory, FAILED일 때만 채운다). ConfirmPayment 재전송의 답과 BatchGetPayments가 읽는다.
-- payment 표는 아직 배포된 적이 없어 행이 없다. 그래서 제약을 NOT VALID로 나누지 않는다(docs/devops.md §7.2 '무거운 변경은 정비 시간에'는 행이 있는 표의 규칙이다).
ALTER TABLE "payment" ADD COLUMN "failure_category" text;--> statement-breakpoint
ALTER TABLE "payment" ADD CONSTRAINT "payment_failure_category_check" CHECK ("payment"."failure_category" IN ('CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED'));