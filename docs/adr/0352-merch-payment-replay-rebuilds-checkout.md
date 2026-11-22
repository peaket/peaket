# ADR-0352: 굿즈 결제 시도의 멱등 결과 참조를 시도 ID로 줄이고 재생 때 결제창 값을 다시 만든다(2026-11-22)

- **상태**: 채택(2026-11-22). W12-core-idem 계획 §13 **OPEN-B(가)**를 감독이 골랐다. 정본을 넓히는 결정이다: [docs/api/guidelines.md](../api/guidelines.md) §4 '예외 둘째'를 티켓 결제 시도에서 굿즈 결제 시도로 넓힌다.
- **관련**: [ADR-0337](0337-core-idempotency-record-role-row-security.md) 결정 6·'결과'의 남는 한계, [ADR-0146](0146-data-retention-gaps-idempotency-records-log-retention.md) 결정 1, [ADR-0299](0299-merch-payments-order-kind-nullable-event-id.md) 결정 3, [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md) 결정 5, [ADR-0044](0044-dual-pg-selection-and-switchover.md), [docs/api/guidelines.md](../api/guidelines.md) §4, [docs/data.md](../data.md) '서비스마다 둔 멱등 기록 표', [docs/features/payment.md](../features/payment.md) §6·§11, [docs/api/openapi.yaml](../api/openapi.yaml) `createShopOrderPayment`·`PaymentAttempt`, [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto) `PrepareCheckoutRequest.pinned_pg`, [docs/security/asvs/payment.md](../security/asvs/payment.md) 8.2.2, [docs/review/plans/W12-merch-replay.md](../review/plans/W12-merch-replay.md), [docs/review/plans/W12-core-idem.md](../review/plans/W12-core-idem.md) §13
- **관련 ID**: P-T77 ①~⑤, FR-015, ASVS v5.0.0-8.2.2

## 맥락

- core-svc 굿즈 결제 시도 시작(`START_MERCH_PAYMENT`, `POST /v1/shop/orders/{orderId}/payments`)은 멱등 기록 표 `idempotency_record`의 결과 참조(`result_ref`)에 **처음 응답 JSON을 통째로** 적는다. 그 안에는 결제사 공개 키(토스 `clientKey`, 포트원 `storeId`·`channelKey`), 구매자 키(`customerKey`), 결제 뒤 돌아올 주소(`successUrl`·`failUrl`·`redirectUrl`), 주문명, 금액이 든다.
- 같은 키 재생은 그 JSON을 그대로 돌려준다(ADR-0337 결정 6). 재생 대조는 시도 ID·결제사·결제창 금액만 본다. 그래서 결제사 공개 키·돌아올 주소의 출처가 바뀌거나, 팬 경로의 잘못된 쿼리·DB 쓰기로 결과 참조가 바뀌면 팬이 **다른 상점의 결제창**으로 간다. ADR-0337 '결과'의 남는 한계 둘째 줄이 이 위험을 남겼다.
- 티켓 결제 시도(`purchase-svc` `POST /v1/orders/{orderId}/payments`)는 이미 결과 참조에 시도 ID만 두고, 재생 때 payment-svc `PrepareCheckout`을 같은 시도 ID·같은 결제사(`pinned_pg`)로 다시 불러 결제창 값을 다시 만든다(guidelines §4 '예외 둘째', BUILD_ORDER PRF-191). 결제창 값은 DB에 두지 않는다.
- 굿즈도 재생에 필요한 사실을 이미 다른 표에 둔다. `merch_payment_attempt`에 시도 ID·주문 ID·결제사·결제수단이 있고, `merch_order`에 계정·금액·회차·결제 상점·재고 예약 만료가 있으며, 항목 이름은 `merch_order_item`에 있다. payment-svc `PrepareCheckout`은 `pinned_pg`를 이미 받고, core-svc gRPC 어댑터만 그 칸을 아직 보내지 않는다.

## 결정

1. **새 결과 참조는 시도 ID 하나다.** `START_MERCH_PAYMENT`의 `idempotency_record.result_ref`는 `merch_payment_attempt.id`(소문자 UUIDv7)다. 결제사 공개 키·구매자 키·돌아올 주소·금액·주문명·`checkout` 글자를 적지 않는다. 저장 함수는 호출자가 넘긴 응답 글이 아니라 시도 ID를 결과 참조로 쓴다(넘기는 자리 자체를 없앤다).
2. **재생의 사실 출처는 주문·시도 행이다.** 같은 키 재생은 (가) 경로 주문을 읽어 세션 계정의 것인지 보고, (나) 결과 참조가 가리키는 시도 행을 읽어 그 주문의 시도인지 본다. 하나라도 맞지 않으면 처음 응답 대신 남의 주문과 같은 404 `not-found`로 답하고, `PrepareCheckout`을 부르지 않으며 아무것도 쓰지 않고, 보안 이벤트 로그 한 줄(`kind` `idempotency-replay-mismatch`, `severity` `SEV2`, `operation`, 경로 주문 ID)을 남긴다. 계정 ID·결과 참조 원문·시도 ID는 로그에 싣지 않는다.
3. **재생은 `PrepareCheckout`을 다시 부른다.** 시도 ID는 처음 것 그대로, `pinned_pg`는 시도 행의 결제사, 금액·주문명·결제 상점·에스크로 상품은 주문·항목에서, 결제수단은 시도 행에 적힌 값을 넘긴다. 결제창 값(공개 키·구매자 키·돌아올 주소)은 지금 서버 설정으로 다시 만든다. 재생은 주문 상태·시도 횟수·판매 정지·재고 예약 만료를 다시 보지 않는다(처음 201을 준 요청이다).
4. **재생이 만든 값이 시도·주문과 어긋나면 돌려주지 않는다.** `PrepareCheckout`이 돌려준 결제사가 시도 행의 결제사와 다르거나, 결제창 금액이 주문 금액과 다르거나, 결제창의 주문 ID(포트원은 `paymentId`의 `pay-{orderId}`와 `customData.orderId`)가 경로 주문과 다르면 503 `dependency-unavailable`로 답하고 결제창 값을 싣지 않는다. `kind` `merch-checkout-replay-mismatch`, `severity` `SEV2`, `orderId`, 어긋난 칸 이름(`pg`·`amount`·`orderId`)만 로그에 남긴다. 값은 싣지 않는다. 다른 상점·다른 금액으로 팬을 보내지 않으려는 것이다.
5. **재생 중 준비 실패는 5xx이고 같은 키로 다시 보낸다.** `unavailable`·`invalid`(수단 불가 포함)는 503 `pg-unavailable`, `paused`(채널 없음·비활성)는 503 `new-payment-paused`, `error`(설정 오류)는 503 `dependency-unavailable`이다. 처음 201을 준 요청이라 400으로 답하지 않는다. 쓰기·기록 변화는 0이고, 같은 키로 다시 보내면 다시 시도한다. 다른 결제사·다른 상점으로 넘어가지 않는다.
6. **옛 결과 참조(배포 호환).** 이 묶음 이전에 쓰인 결과 참조는 처음 응답 JSON이다. 새 코드는 그 글에서 `attemptId` 하나만 꺼내 2~5의 새 길로 재생하고, 저장된 공개 키·구매자 키·돌아올 주소·금액은 버린다. 그래서 옛 키의 재시도는 배포 창에도 이어지고, 저장값이 다시 팬에게 나가지 않는다. JSON이 아니거나 `attemptId`가 UUID가 아니면 2의 404다.
7. **정본을 넓힌다.** guidelines §4 '예외 둘째'의 범위를 티켓 결제 시도에서 굿즈 결제 시도까지 넓힌다. data.md의 멱등 기록 표 문단과 openapi `createShopOrderPayment` 설명, features/payment.md §6, asvs/payment 8.2.2, ADR-0337 '결과'의 남는 한계를 같은 말로 고친다.
8. **마이그레이션은 없다.** 표·칸·권한·계약 응답 모양은 그대로다. `packages/contracts`·`packages/api-client`는 설명 변경이 생성물에 닿는지 `gen`으로 확인한다.

## 결과

- `idempotency_record`에 굿즈 결제창 값이 남지 않는다. 공개 키·구매자 키·돌아올 주소의 출처가 바뀌어도 재생은 지금 설정으로 만들고, 옛 저장값은 돌려주지 않는다. ADR-0337 '결과'의 남는 한계 둘째 줄은 닫힌다.
- 재생의 시도 ID가 경로 주문·세션 계정의 것이 아니면 404이고 `PrepareCheckout`·쓰기 0이다. 재생이 다른 결제사·금액·주문을 만들면 503이고 결제창 값을 싣지 않는다. 재생 준비 실패는 5xx이고 같은 키로 다시 보낼 수 있다.
- 같은 멱등키 재생은 시도 ID·결제사·주문·금액이 처음과 같고, 공개 키·구매자 키·돌아올 주소·`switched`·`depositDueAt`은 다시 만든 값(지금 설정)이다. 구매자 키는 저장하지 않는 CSPRNG 불투명 값이라 첫 응답과 다를 수 있다. 결제·승인은 이 값에 기대지 않는다.
- 남는 한계:
  - 주문·시도 행 자체의 무결성은 이 묶음이 닫지 못한다. 팬 경로 역할 `core_app`은 `merch_order`·`merch_order_item`에 표 단위 고치기 권한이 있어(W12-core-idem §14 '높음 후보(돈)'), 그 행의 금액·결제사·주문 ID를 바꾸는 공격자는 재생이 만드는 값을 바꿀 수 있다. 재생은 이제 그 행을 사실로 믿는다. 파트너 경로 역할의 표 단위 권한을 줄이는 새 묶음이 맡는다.
  - 배포 창: 새 코드가 쓴 시도 ID 참조를 이전 판 파드가 읽으면 404다(이전 판은 JSON만 읽는다). 파드 교체가 끝나면 사라진다. 카나리 배포를 권한다. 옛 JSON 참조는 새 코드가 읽는다.
  - `START_MERCH_PAYMENT` 밖 여섯 굿즈 작업의 결과 참조 모양은 그대로다.

## 다른 선택지

| 안 | 고르지 않은 까닭 |
| --- | --- |
| 지금처럼 결제창 값 JSON을 저장하고 재생 때 그대로 돌려준다 | 공개 키·돌아올 주소가 저장값이라, 결과 참조를 바꾸는 쿼리 하나로 팬이 다른 상점으로 간다(ADR-0337이 남긴 위험) |
| 결제창 값의 해시를 저장해 재생 때 대조한다 | 대조를 지나도 돌려주는 값은 저장값이다. 설정이 바뀌면 옛 공개 키·주소가 그대로 나가고, 해시는 DB 쓰기 권한으로 다시 계산할 수 있다 |
| 결과 참조에 서버 비밀 키로 서명을 붙인다 | DB 변조는 잡지만 새 비밀 키·교체·배포가 든다. 재생이 지금 설정을 쓰는 것이 데이터 최소화와 설정 일관성에 더 맞다 |
| 시도 ID만 저장하고 옛 JSON 참조는 404로 끝낸다 | 배포 창에 옛 키의 재시도가 404가 된다. 안의 시도 ID만 읽으면 이어지고 저장값도 돌려주지 않는다 |
| `merch_payment_attempt`에 금액·공개 키를 더 저장한다 | 표를 늘려도 저장값은 변조될 수 있고, 데이터 최소화에 어긋난다. 금액은 주문 행, 결제사는 시도 행으로 충분하다 |
| 재생이 결제창 값을 만들지 못하면 저장값으로 대신한다 | 실패를 숨기고 옛 공개 키·주소를 내보낸다. 5xx로 답하고 같은 키로 다시 보내게 한다(guidelines §4) |
