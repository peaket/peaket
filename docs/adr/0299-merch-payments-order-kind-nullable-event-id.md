# ADR-0299: 굿즈 결제는 결제 원장에서 주문 종류로 가르고 회차 칸을 비운다(2026-11-18)

- **상태**: 채택(2026-11-18, 추천 적용. 갈래 5 BAT-600 계획 담당이 정본 빈칸으로 정했다. BUILD_ORDER PRF-180이 넘긴 'payment-svc `ConfirmPayment`의 `event_id` 필수를 LCH-010이 풀거나 다른 길을 정한다'에 답한다. 결제 흐름과 결제사 고정(ADR-0044), 결제 결과 당기기(ADR-0140)는 그대로 두고, 그 위에 굿즈 주문이 지나갈 길만 정한다)
- **관련**: [ADR-0044](0044-dual-pg-selection-and-switchover.md)(결제사 선택과 고정), [ADR-0107](0107-expire-unpaid-orders-ticket-expired-merch-stock-reservation.md)(굿즈 재고 예약), [ADR-0140](0140-payment-result-pull-fallback-when-kafka-is-late.md)(결과 당기기), [ADR-0150](0150-event-schema-required-fields-always-present.md), [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md), [docs/features/payment.md](../features/payment.md) §2 '승인 명령 접수의 첫 구현'·'선택기의 첫 구현', [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto), [docs/api/avro/peaket/trade/PaymentEvent.avsc](../api/avro/peaket/trade/PaymentEvent.avsc), [docs/features/settlement.md](../features/settlement.md) §4.5, [docs/review/plans/BAT-600.md](../review/plans/BAT-600.md)
- **관련 ID**: P-T56, P-T57, FR-015, FR-014, BUILD_ORDER LCH-010·PRF-180

## 맥락

- payment-svc의 승인 명령 접수(`ConfirmPayment`, PRF-180)는 회차 표(티켓) 주문만 받는다. 요청의 `event_id`(회차 ID)가 필수이고 결제 원장 `payment.event_id`가 NOT NULL이다. 결제 사건(`PaymentEvent`)의 `eventId`도 null을 받지 않고, 사건을 Kafka(사건을 순서대로 쌓아 나눠 주는 메시지 저장소)에 보낼 때의 키도 회차 ID다.
- 굿즈 주문(core-svc shop)에는 회차가 없다. 티켓 연동 부가 상품(주차권 같은, 티켓과 함께 쓰는 상품)에는 연결 회차가 있지만, 그 결제를 회차 결제로 적으면 회차 정산서(회차가 끝난 뒤 결제사별로 만드는 정산서)가 그 결제를 티켓 판매로 셈한다. 상품 정산은 shop의 주문 항목으로 따로 계산한다(settlement §4.5). 같은 돈이 두 정산서에 들어가면 안 된다.
- 결제창 준비(`PrepareCheckout`)는 이미 주문 종류(`order_kind`) 칸이 있지만 `ORDER_KIND_TICKET`만 받는다. 굿즈의 복귀 주소(결제창이 끝난 뒤 돌아올 화면 주소)가 정해지지 않았기 때문이다.

## 결정

1. **결제 원장에 주문 종류 칸을 두고, 굿즈는 회차 칸을 비운다(추천 적용).**
   - `payment` 표에 `order_kind text NOT NULL DEFAULT 'TICKET'`(값 `TICKET`·`MERCH`)를 더하고, `event_id`를 NULL 허용으로 바꾼다. 둘을 묶는 CHECK `(order_kind = 'TICKET') = (event_id IS NOT NULL)`을 둔다. 있는 행은 모두 `TICKET`이다.
   - 티켓 연동 부가 상품도 `MERCH`이고 회차 칸이 비어 있다. 그래서 회차 정산서의 결제 읽기(`event_id = $1`)에 굿즈 결제가 걸리지 않는다. 상품 정산서는 지금처럼 shop 원천으로 만든다.
   - 일일 대사(결제사 거래 내역과 원장 맞추기)는 지금처럼 모든 결제를 본다.
2. **승인 명령 요청에 주문 종류를 더한다(추천 적용).**
   - `ConfirmPaymentRequest`에 `OrderKind order_kind = 12`를 더한다(buf 호환을 깨지 않는 추가). 지금 purchase-svc는 이 칸을 보내지 않으므로 `ORDER_KIND_UNSPECIFIED`는 `TICKET`으로 본다.
   - `TICKET`은 지금 규칙 그대로다(`event_id` 필수).
   - `MERCH`는 `event_id`와 `entry_opens_at`이 비어 있어야 하고, 있으면 `INVALID_ARGUMENT`이며 아무것도 쓰지 않는다. 그 밖의 입력 검사(소문자 UUID, 금액, 결제 참조, 인증 시각 상한)는 같다.
   - 같은 주문으로 다시 부를 때 있는 행과 견주는 값(`attempt_id`·`pg`·`amount`)에 `order_kind`를 더한다. 다르면 `FAILED_PRECONDITION`과 SEV2 로그 한 줄(`kind` payment-confirm-mismatch)이다.
3. **결제창 준비가 굿즈를 받는다(추천 적용).**
   - `PrepareCheckout`은 `ORDER_KIND_MERCH`를 받는다. `event_id`는 비어도 된다. 있으면(티켓 연동 부가 상품의 연결 회차) 그 회차의 지정·전환 행을 보고, 비면 플랫폼 행과 플랫폼 기본·대체만 본다.
   - 굿즈의 복귀 주소는 `{PEAKET_WEB_ORIGIN}/shop/checkout/return?order={orderId}&pg={결제사}`다(성공·실패 같은 주소). 웹 화면 쪽 같은 모양의 함수는 굿즈 결제 화면을 만드는 단계가 둔다.
   - 굿즈는 가상계좌를 허용 수단에서 뺀다(`VIRTUAL_ACCOUNT` 요청은 `INVALID_ARGUMENT`). 굿즈의 입금 대기(docs/planning/03 §2.13 O2~O4)와 그동안의 재고 예약 길이는 BAT-605(LCH-030, 결제대금예치와 함께)가 정한다. 승인 명령에는 `virtual_account_allowed = false`를 싣는다.
   - 결제 상점(일반·결제대금예치)을 고르는 칸은 아직 없다. 택배 주문(결제대금예치 상점, POL-014)의 결제창 값은 BAT-605가 더한다. 그때까지 core-svc는 택배 주문의 결제 시도 시작을 503 `pg-unavailable`로 답하고, 주문 만들기도 재고를 잡기 전에 같은 503으로 답한다(ADR-0300 결정 4·5, 추천 적용, 2026-11-19, BAT-600 리뷰 반영).
4. **결제 사건의 회차 칸을 비울 수 있게 하고 주문 종류를 싣는다(추천 적용).**
   - `PaymentEvent.eventId`를 `["null", "string"]`(기본값 null)로 푼다. 필수 칸을 null 허용으로 푸는 변경은 호환 검사를 통과하므로 소비자를 먼저 고친다(docs/api/avro/README.md §3).
   - 새 칸 `orderKind`(열거 `PaymentEventOrderKind` = `UNRECOGNIZED`·`TICKET`·`MERCH`, 열거 기본값 `UNRECOGNIZED`, 칸 기본값 `TICKET`)를 더한다. 생산자는 `UNRECOGNIZED`를 내지 않는다.
   - Kafka 키는 `TICKET`이면 지금처럼 회차 ID, `MERCH`이면 주문 ID다(굿즈는 주문 안의 차례만 지키면 된다).
   - 소비자는 지금 purchase-svc 하나다. purchase-svc는 `orderKind`가 `TICKET`이 아닌 사건을 반영하지 않고 건너뛴다(지표 `payment_result_skipped_total{reason}`의 `merch`·`unrecognized`). 결과 당기기 답에 굿즈 주문이 섞일 일은 없다(purchase-svc는 자기 주문만 묻는다).
5. **core-svc shop은 결과를 당기기로만 받는다(첫 구현, 추천 적용).**
   - core-svc는 아직 `trade.payments`를 읽지 않는다. 승인 명령을 낸 굿즈 주문의 결과는 `BatchGetPayments`로 당겨 반영한다(간격과 반영 규칙은 ADR-0300 결정 5). 사건을 읽는 소비자는 굿즈 결제가 늘어 당기기 부담이 재어질 때 더한다.
   - 굿즈 결제 취소(미수령 자동 취소 등)는 지금 있는 `CancelPayment`를 그대로 쓴다. 결제 ID는 승인 명령 답의 `payment_id`를 주문에 적어 둔 값이다.
6. **부르는 쪽 제한은 지금 규칙 그대로다.** payment.proto 첫머리의 부르는 쪽 목록(purchase-svc·core-svc·ops-svc)과 메시의 L7 허용 목록(HOT-400)이 core-svc를 받는다. 앱 안에는 목록을 두지 않는다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 주문 종류 칸 + 굿즈는 회차 칸 비움(이 결정) | 회차 정산서에 굿즈가 섞이지 않는다. 원장만 보고 티켓·굿즈를 가른다 | 결제 사건 계약을 바꿔 소비자를 먼저 배포해야 한다 | 고른다 |
| B. 티켓 연동 부가 상품은 연결 회차를, 굿즈는 빈 값을 적음 | 부가 상품을 회차로 묶어 볼 수 있다 | 회차 정산서가 부가 상품 결제를 티켓 판매로 센다(상품 정산서와 두 번) | 쓰지 않는다 |
| C. 사건의 `eventId`에 빈 글자를 넣고 계약을 바꾸지 않음 | 배포 차례가 없다 | '회차 ID'라는 칸 뜻이 깨지고 소비자가 빈 값을 회차로 읽을 수 있다 | 쓰지 않는다 |
| D. 굿즈 결제를 별도 표·별도 토픽으로 | 티켓 경로를 전혀 건드리지 않는다 | 승인 실행기·UNKNOWN 해소·대사·취소를 두 벌 둔다 | 쓰지 않는다 |

## 결과

- 굿즈와 티켓 연동 부가 상품이 같은 결제 원장·승인 실행기·결제사 고정을 쓴다. 회차 정산서와 상품 정산서가 같은 결제를 두 번 세지 않는다.
- 대가: 결제 사건 계약 판이 하나 오르고, purchase-svc(소비자)를 payment-svc(생산자)보다 먼저 배포해야 한다. core-svc는 당기기만 써서 결과 반영이 사건보다 늦다(ADR-0300 결정 5의 간격만큼).

## 되돌릴 조건

- 굿즈 결제의 결과 반영 지연(접수부터 PAID까지) p99가 결제 확정 목표(NFR-006, 3초)를 넘는다고 재어지면 core-svc에 `trade.payments` 소비자를 더한다.
- 상품 정산이 결제 원장을 직접 읽어야 하는 요구가 생기면 `order_kind`로 고른다(회차 칸을 채우지 않는다).
