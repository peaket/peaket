# ADR-0315: 굿즈 취소·반품 상태 기계의 첫 구현(2026-11-19)

- **상태**: 채택(2026-11-19, 추천 적용. 갈래 5 BAT-605 계획 담당이 정했고 감독이 구매자 쪽(I2·I7~I10·I16)만, 판매자 전이(I11~I15)는 함수 경계만으로 확인했다. 방향은 [ADR-0293](0293-fan-reauth-token-bound-to-receiving-operation.md)(재인증 `op`), [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 3·4(환급 계좌는 바로 넘길 때만), [ADR-0301](0301-ticket-addons-fulfillment-unclaimed-auto-cancel.md)(부가 상품·미수령) 그대로다)
- **관련**: [docs/features/payment.md](../features/payment.md) §6 '굿즈 취소·반품의 첫 구현', [docs/features/transfer-refund.md](../features/transfer-refund.md) §3.1 '팬 취소의 재인증 확인', [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §1.4 POL-016·§2.13 I2·I7~I10·I16, [docs/data.md](../data.md) `merch_order_item`·`merch_refund`·`merch_refund_item`·§5, [docs/api/openapi.yaml](../api/openapi.yaml) `createShopOrderCancellation`·`createShopOrderReturn`, [docs/review/plans/BAT-605.md](../review/plans/BAT-605.md)
- **관련 ID**: P-T61, P-T62, P-T63, P-T64, V-T35 ③, FR-014, FR-015, POL-014, POL-016, BUILD_ORDER LCH-030

## 맥락

- BAT-600은 굿즈 주문·결제·재고·미수령 자동 취소까지 만들었지만 구매자 취소·반품 받는 층이 없다. openapi에는 `createShopOrderCancellation`·`createShopOrderReturn`이 이미 있다.
- `merch_order_item`에는 `shipped_at`·`delivered_at`·`picked_up_at`·`return_requested_at`·`return_resolved_at`·`refunded_amount`·`cancel_reason`만 있고, data.md의 송장·반품 칸은 DB에 없다. `merch_refund`는 미수령 자동 취소용 네 상태만 쓰고 종류 칸이 없다.
- 환급 계좌는 저장하지 않는다(POL-014). 환급을 바로 할 때만 요청 본문에서 받아 결제사 취소에 넘긴다.
- 판매자 송장·도착 확인·거절·환급(I3·I6·I11~I15)을 받는 서버는 없다(BAT-610 기록의 막힘). 이 묶음은 구매자 쪽만 연다.

## 결정

1. **취소 자격(I2)**: 결제 완료(`PAID`) 주문의 `READY` 항목만 받는다(택배 발송 전, 현장 수령 전, 부가 상품은 연결 회차 입장 시작 전). `itemIds`가 없으면 READY 항목 전부이고 1~20개·중복 없음·그 주문의 항목이어야 한다(아니면 400·404). 그 밖은 409 `merch-cancel-not-allowed`, 부가 상품이 입장 시작 뒤면 409 `entry-started`다. 부가 상품인데 연결 회차 입장 시각을 읽지 못하면(eventId 없음·event 행 없음) 취소는 409 `entry-started`, 단순 변심 반품은 409 `merch-return-not-allowed`로 닫는다(RV-04).
2. **금액**: 주문의 남은 항목(이미 `CANCELLED`·`REFUNDED`가 아닌 항목)을 모두 덮는 취소는 처음 배송비를 포함한 주문 금액, 일부 항목은 그 항목 금액(수량 × 주문 때 단가)만이다. 항목을 나눠 취소해 마지막 남은 항목을 취소할 때도 배송비를 한 번 돌려준다(RV-01). 남는 항목이 있으면 배송비를 돌려주지 않는다. 에스크로 주문은 구매 확정 전 주문 전체만 취소하고 부분은 409 `escrow-partial-not-allowed`다(ADR-0313).
3. **취소 ID와 행**: `merch_refund.id`(UUIDv7)가 취소 ID이고 결제사 멱등키는 `cancel-{취소 ID}`다. 같은 트랜잭션이 `merch_refund`(`kind=USER_CANCEL`, `REQUESTED`)와 `merch_refund_item`(항목 하나에 진행 중 환급 하나, 부분 유일)과 멱등 기록을 쓴다. 항목 상태는 결제사 답을 받기 전에 바꾸지 않는다. 같은 항목에 활성 환급 자리가 있으면 반품 요청은 409 `merch-return-not-allowed`이고 미수령 자동 취소는 그 항목을 건너뛴다(취소·반품·미수령 겹침에서 이중 환급 0, RV-02·RV-03).
4. **결제사 취소와 전이**: 커밋 뒤 `CancelPayment`를 한 번 부른다. `CANCELLED`면 항목 `REFUNDED`(I16)·`refunded_amount`·응답 `REFUNDED`, `CANCEL_PENDING`·`UNKNOWN`이면 항목 `CANCELLED`(취소 효력 즉시)·응답 `REFUND_PENDING`, `REFUND_ACCOUNT_REQUIRED`·`REJECTED`면 환급 행 `REJECTED`·항목 그대로·422다. 결제사 취소가 성공한 뒤 환급 결과 DB 쓰기가 실패하면 202 `REFUND_PENDING`으로 답하고 재시도가 같은 취소 ID로 끝낸다(RV-07).
5. **환급 계좌·재인증**: 가상계좌 결제(`GetPayment.virtual_account_paid`)인데 계좌가 없으면 422 `refund-account-required`이고 아무것도 쓰지 않는다. 계좌 모양은 공용 `refundAccountShape`와 같고 틀리면 400 `invalid-body`다. 계좌를 보낸 요청은 `act=FAN_HIGH_RISK`·`op=SHOP_CANCEL_REFUND_ACCOUNT` 재인증이 필수다(403 `reauth-required`, 확인기·저장소 장애 503 `reauth-unavailable`·Retry-After 5초 [가정]). 계좌는 결제사 취소 본문에만 실어 보내고 저장·로그·사건·Outbox에 남기지 않는다. 카드 결제에 온 계좌는 결제사로 보내지 않는다.
6. **재시도**: 1분 → 5분 → 15분 → 1시간 → 6시간, 5회 [가정]이고 같은 취소 ID를 쓴다. 5회를 넘기면 `RETRY_EXHAUSTED`로 멈추고 CS가 이어 본다. 계좌 거절은 자동 재시도를 멈추고 `account_required_at`을 쓴다(계좌 다시 받기는 GAT-130).
7. **반품(I7~I10)**: `DELIVERY`는 `SHIPPED`(수취 거부)·`DELIVERED`, `PICKUP`은 `PICKED_UP`, 부가 상품은 `READY`·`LOCKED`(입장 시작 뒤에는 이상·다름만)일 때 받는다. 단순 변심은 받은 날부터 7일, 이상·다름은 3개월이다. 받은 날 기록이 없으면 기한 안으로 받는다. 결제사를 부르지 않고 계좌도 받지 않으며 `RETURN_REQUESTED`·사유·반품 송장(선택)·요청 시각만 쓴다. 에스크로는 구매 확정 전 주문 전체 항목만 받는다.
8. **판매자 전이 경계(I11~I15)**: `sellerReturnTransition(from, action)` 순수 함수만 둔다(`RETURN_REQUESTED → RETURN_RECEIVED`, `RETURN_RECEIVED → REFUNDED|DISPUTED`, `DISPUTED → REFUNDED|DELIVERED`). `RETURN_REQUESTED`에서 바로 환급하지 않고, `DISPUTED`의 환급은 CS 인정만 받는다. HTTP는 BAT-610 잔여(7.2.1)가 연다.
9. **저장(0030·0031)**: `merch_order_item`에 `tracking_no`·`return_reason`(CHECK 두 값)·`return_tracking_no`·`return_received_at`·`reject_reason`·`settle_eligible_at`·`statement_id`, `merch_refund`에 `kind`·`attempts`·`fail_reason`·`account_required_at`, 새 표 `merch_refund_item`. 취소 사유 CHECK에 `USER_CANCEL`을 더한다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 환급 행·항목 자리를 먼저 커밋하고 결제사 답으로 항목을 바꾼다(이 결정) | 결제사 취소 전에 항목을 팔 수 없게 만들지 않고(거절이면 그대로), 같은 항목의 두 환급을 DB가 막는다 | 항목 전이와 결제사 호출 사이에 짧은 틈이 있다 | 고른다 |
| B. 항목을 먼저 CANCELLED로 커밋하고 결제사를 부른다 | 다른 경로가 항목을 가져가지 못한다 | 계좌 거절·업무 거절이면 되돌려야 하고, 되돌림 사이에 돈이 어긋날 수 있다 | 쓰지 않는다 |
| C. 재시도마다 새 취소 ID | 구현이 단순하다 | 결제사에 취소가 여러 건 생길 수 있다 | 쓰지 않는다 |

## 결과

- 구매자는 발송·수령 전 굿즈와 입장 시작 전 부가 상품을 취소하고, 가상계좌면 계좌를 넣어 전액 환급받는다. 반품은 접수되고 판매자 처리(7.2.1)를 기다린다.
- 대가: core-svc에 취소·반품·재시도 유스케이스, 환급 행 종류·항목 자리 표, 재인증 게이트 복제, 마이그레이션 둘이 는다. 계좌 다시 받기·CS 처리함·판매자 받는 층은 다음 묶음이다.

## 되돌릴 조건

- `merch_refund_item` 부분 유일이 실제 경합에서 409를 자주 내면 취소 전에 주문 잠금으로 줄을 세우는 범위를 넓힌다.
- 5회 재시도가 대부분 소진되면 payment-svc 취소 API의 비동기 확정 주기를 다시 재고 간격을 고친다.
- 판매자 받는 층(7.2.1)이 생기면 반품 도착 확인·거절·환급의 HTTP 계약과 `sellerReturnTransition`을 잇고 이 ADR의 'HTTP 없음'을 지운다.
