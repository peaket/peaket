# ADR-0313: 택배 결제대금예치 결제의 첫 구현(2026-11-19)

- **상태**: 채택(2026-11-19, 추천 적용. 갈래 5 BAT-605 계획 담당이 LCH-030의 정본 빈칸으로 정했고 감독이 보수안을 골랐다. 방향은 [ADR-0062](0062-open-items-delegated-decisions.md)(결제대금예치·가상계좌·환불 계좌 미저장), [ADR-0299](0299-merch-payments-order-kind-nullable-event-id.md)(굿즈 결제의 원장 길), [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md)(굿즈 주문·재고) 그대로다)
- **관련**: [docs/features/payment.md](../features/payment.md) §2.1 '에스크로' 행·§6 '결제대금예치 선택권'·'굿즈 결제대금예치·가상계좌의 첫 구현', [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) POL-014·POL-016 §1.4, [docs/api/openapi.yaml](../api/openapi.yaml) `createShopOrderPayment`, [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto) `PaymentStore`, [docs/review/plans/BAT-605.md](../review/plans/BAT-605.md), [docs/BUILD_ORDER.md](../BUILD_ORDER.md) BAT-605
- **관련 ID**: P-T59, P-T60, FR-014, FR-015, POL-014, BUILD_ORDER LCH-030

## 맥락

- 굿즈 택배 주문은 선지급식 통신판매다. 신용카드가 아닌 결제(체크카드·계좌이체·가상계좌)에는 전자상거래법 §13②10호·§24②의 결제대금예치(에스크로) 선택권을 줘야 한다. 티켓·부가 상품·현장 수령 굿즈는 §24③3호로 빠진다(ADR-0062).
- BAT-600은 택배 주문의 결제를 열지 않았다. 결제 시도 시작이 503 `pg-unavailable`이고, `PrepareCheckout`은 `virtual_account_allowed=false`, `ConfirmPayment`는 `pg_store`를 보내지 않아 승인 원장이 늘 `STANDARD`다.
- 결제사 포트에는 에스크로 구매 확정을 읽는 호출이 없다. 토스 에스크로는 구매자가 결제사 메일에서 확정하고 3영업일 뒤 자동 확정되지만, `ConfirmPayment`·`GetPayment` 계약에 `escrow`·`purchase_confirmed_at`이 없다.

## 결정

1. **상점**: 택배(`DELIVERY`) 주문만 `pg_store = ESCROW`로 만든다. 현장 수령·부가 상품은 `STANDARD`다. `merch_order.pg_store`에 적고, 주문 응답의 `paymentStore`로 보인다.
2. **결제창**: `PrepareCheckout.payment_store = ESCROW`와 `escrow_products`(상품 ID·이름·단가·수량)를 싣는다. `useEscrow`는 넣지 않아 구매자가 결제창에서 고른다. 에스크로 상점의 허용 수단은 카드·계좌이체·가상계좌이고, 간편결제·휴대폰은 채널 표에서 빼고 코어가 결제사를 부르기 전에 400 `checkout_invalid`로 막는다. 에스크로 주문은 토스로만 결제한다(다른 결제사 전환은 쓰지 않는다).
3. **원장**: `ConfirmPayment.payment_store = ESCROW`를 보내 `payment.pg_store`에 적고, 같은 주문 재호출에서 다르면 `FAILED_PRECONDITION`이다(payment-svc가 이미 대조한다).
4. **구매 확정 전 전체 취소**: 결제사에서 구매 확정을 읽을 수 없으므로 `merch_order.escrow = false`, `purchase_confirmed_at = null`로 둔다(보수안). 에스크로 주문은 구매 확정 전에는 주문 전체만 취소·반품하고 부분은 409 `escrow-partial-not-allowed`다. 구매 확정을 읽는 길이 생기기 전에는 부분 취소를 열지 않는다. 결제사가 부분 취소를 거절하는 것과 같은 방향이라 돈이 새지 않는다.
5. **배송 정보**: 판매자 송장 등록(I3)과 결제사 배송 정보 등록은 BAT-610 잔여(7.2.1)다. 이 묶음은 상태 전이 함수의 경계만 둔다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. `pg_store=ESCROW`로 가르고 구매 확정 전 전체 취소만(이 결정) | 결제사 계약을 바꾸지 않고 선택권 의무를 지킨다. 부분 취소가 열리지 않아 돈이 새지 않는다 | 구매 확정 뒤에도 부분 취소가 막힌다 | 고른다 |
| B. `GetPayment`에 에스크로·구매 확정을 더해 부분 취소를 연다 | 정본 상태와 맞다 | payment-svc·proto·결제사 어댑터를 함께 고쳐야 하고 이 묶음이 2일을 넘는다 | 다음 묶음 |
| C. 에스크로를 켜지 않고 택배 결제를 연다 | 구현이 작다 | 전자상거래법 선택권 의무를 지키지 못한다 | 쓰지 않는다 |

## 결과

- 택배 주문은 201로 만들어지고 결제 시도가 열린다. 결제창에는 에스크로 상품이 실리고, 승인 원장은 `pg_store=ESCROW`로 남는다.
- 대가: 에스크로 상점·상품 계약, `PaymentStore` enum, 결제 상태 조회가 늘었다. 구매 확정을 읽는 길과 부분 취소는 다음 묶음이다.

## 되돌릴 조건

- 결제사가 에스크로 상점의 상품 목록을 더 이상 받지 않거나 `useEscrow` 필수로 바뀌면 이 결정을 다시 본다.
- 에스크로 주문의 전체 취소가 실제 결제사에서 거절된다고 재어지면, 구매 확정 조회를 payment-svc에 먼저 더한다.
