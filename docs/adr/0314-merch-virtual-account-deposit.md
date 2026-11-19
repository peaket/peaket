# ADR-0314: 굿즈 가상계좌 입금 대기의 첫 구현(2026-11-19)

- **상태**: 채택(2026-11-19, 추천 적용. 갈래 5 BAT-605 계획 담당이 정했고 감독이 P-T59~P-T64·V-T35 ③ 몫으로 확인했다. 방향은 [ADR-0062](0062-open-items-delegated-decisions.md)의 가상계좌 처리 규칙과 [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md)의 재고 예약 그대로다)
- **관련**: [docs/features/payment.md](../features/payment.md) §6 '입금 확인의 첫 구현'·'굿즈 결제대금예치·가상계좌의 첫 구현', [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §2.13 O2~O4·§2.4, [docs/api/openapi.yaml](../api/openapi.yaml) `ShopPaymentStatus`, [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto) `GetPayment`, [docs/data.md](../data.md) `merch_order.stock_reserved_until`, [docs/review/plans/BAT-605.md](../review/plans/BAT-605.md)
- **관련 ID**: P-T60, FR-015, POL-014, BUILD_ORDER LCH-030

## 맥락

- 굿즈는 BAT-600까지 가상계좌를 받지 않았다. core-svc가 `payMethod: VIRTUAL_ACCOUNT`를 400으로 막았고 payment-svc도 MERCH의 가상계좌를 `INVALID_ARGUMENT`로 거절했다.
- 티켓 주문에는 입금 대기(O1~O7) 구현이 이미 있다. 입금 기한은 다음 날 23:59 KST [가정], 기한 + 10분 [가정]에 조회해 끝내며, 승인 답·조회 답에 `virtualAccount`와 `depositDueAt`이 있다.
- 굿즈 주문에는 좌석 홀드가 없고 재고 예약(`stock_reserved_until`, 15분 [가정])만 있다. 입금을 기다리는 동안 재고를 얼마나 쥘지 정해야 한다.

## 결정

1. **가상계좌 허용**: 굿즈도 `VIRTUAL_ACCOUNT`를 받는다(택배·현장 수령 모두). core-svc는 `PrepareCheckout.virtual_account_allowed = true`, `ConfirmPayment.virtual_account_allowed = true`를 보낸다.
2. **입금 기한**: 다음 날 23:59 KST [가정]이다. `PrepareCheckoutResponse.deposit_due_at`과 `PaymentAttempt.depositDueAt`에 싣는다. 굿즈는 회차 입장 시각 상한(`entry_opens_at`)을 쓰지 않는다(좌석이 없다).
3. **상태**: 승인 답이 입금 대기면 주문을 `AWAITING_DEPOSIT`으로 바꾸고 `payment_id`·`pg`를 적는다. 재고 예약(`stock_reserved_until`)을 입금 기한 + 10분 [가정]까지 한 번 늘린다(Redis `EXTEND` 1회). 입금 확인은 `PAID`·`RELEASE(restore=0)`, 기한 + 10분 경과는 `EXPIRED`·`RELEASE(restore=1)`·`product_stock` 복구다. 승인 결과가 늦게 와도 조건부 전이라 만료와 입금 확인 가운데 먼저 커밋한 하나만 이긴다.
4. **만료 작업**: 새 칸을 두지 않고 `stock_reserved_until`을 입금 만료 시각으로 겸용한다. 릴레이 리더가 `AWAITING_DEPOSIT` 주문을 부분 인덱스로 찾아 조건부 `EXPIRED`로 끝낸다. 재고 Redis 원소는 만료 작업이 직접 풀지 않고 DB 만료가 끝낸 뒤 `RELEASE(restore=1)`로 한 번만 돌린다(두 번 돌리지 않는다).
5. **결제 상태 응답**: `AWAITING_DEPOSIT`일 때만 payment-svc `GetPayment`(데드라인 300ms [가정])로 은행·계좌번호·입금 기한을 읽어 `virtualAccount`에 싣는다. 계좌번호는 응답에만 있고 로그·사건·지표에 싣지 않는다. 읽기가 일시 실패하면 계좌 없는 `ACCEPTED`로 답해 화면이 계속 묻는다. `PAID`·`EXPIRED`에는 칸이 없다.
6. **저장**: 새 마이그레이션은 core-svc 0030·0031뿐이다. payment-svc는 `deposit_due_at`·가상계좌 칸이 이미 있어 마이그레이션이 없다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. `stock_reserved_until`을 입금 만료로 겸용(이 결정) | 새 칸·마이그레이션이 작다. 재고 만료 작업과 같은 잠금·조건부 전이를 쓴다 | 한 칸이 두 뜻(재고 예약·입금 기한)을 가진다 | 고른다 |
| B. `deposit_due_at` 새 칸 | 뜻이 하나다 | 계획의 마이그레이션 목록에 없고 칸 둘이 어긋날 수 있다 | 쓰지 않는다 |
| C. payment-svc만 입금 대기를 알고 core는 결과만 받는다 | core가 단순하다 | 기한 + 10분에 재고를 정확히 풀 수 없고 화면이 계좌를 읽을 길이 없다 | 쓰지 않는다 |

## 결과

- 굿즈 주문이 가상계좌로 결제되면 입금 대기 동안 재고가 기한 + 10분까지 유지되고, 화면은 은행·계좌번호·기한을 읽는다.
- 대가: `GetPayment` 호출이 결제 상태 조회에 붙고, 만료 작업이 `AWAITING_DEPOSIT`을 함께 본다. 계좌번호를 저장하지 못한 환경(키 없음)은 번호 없이 답한다.

## 되돌릴 조건

- 입금 대기 만료 작업이 한 바퀴에 `EXPIRY_BATCH`를 넘겨 밀리면 부분 인덱스와 묶음 크기를 다시 잰다.
- 결제사가 굿즈 가상계좌 발급을 거절한다고 재어지면 payment-svc 채널 표에서 MERCH의 VA를 다시 빼고 이 ADR을 고친다.
