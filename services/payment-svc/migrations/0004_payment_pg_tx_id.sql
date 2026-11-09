-- 결제 원장에 포트원 결제 시도 ID를 더한다(docs/data.md §2 payment·§4 '결제 표 마이그레이션', docs/features/payment.md §2.1 '포트원 어댑터의 첫 구현', BUILD_ORDER HOT-140 코드 리뷰).
-- 승인 본문의 txId 검증값이고, 조회 답이 이 시도의 것인지 대조하는 값이다. 토스·시뮬레이터는 비워 둔다. 비밀이 아니라 결과가 정해져도 지우지 않는다.
ALTER TABLE "payment" ADD COLUMN "pg_tx_id" text;
