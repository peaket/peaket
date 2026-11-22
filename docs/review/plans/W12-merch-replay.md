# 작업 계획: W12-merch-replay(굿즈 결제 시도의 결제창 값을 저장하지 않고 재생 때 다시 만든다)

- **무엇**: core-svc 굿즈 결제 시도 시작(`START_MERCH_PAYMENT`, `POST /v1/shop/orders/{orderId}/payments`)의 멱등 결과 참조(`idempotency_record.result_ref`)가 지금은 **처음 응답 JSON 통째**다. 그 안에 결제사 공개 키(`clientKey`·`storeId`·`channelKey`), 구매자 키(`customerKey`), 돌아올 주소(`successUrl`·`failUrl`·`redirectUrl`), 금액이 들어 있다. 같은 키 재생은 그 글을 그대로 돌려준다. 재생 대조(ADR-0337 결정 6)는 시도 ID·결제사·금액만 보므로, 팬 경로의 잘못된 쿼리나 DB 쓰기 권한 하나로 공개 키·돌아올 주소를 바꾸면 팬이 **다른 상점의 결제창**으로 간다. 이 묶음은 티켓 결제 시도(`purchase-svc`)와 같은 꼴로, 결과 참조에 **시도 ID 하나만** 남기고 재생 때 payment-svc `PrepareCheckout`을 같은 시도 ID·같은 결제사로 다시 불러 결제창 값을 다시 만든다. 검증 기록이고 규범이 아니다. 정본은 `docs/`가 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane5`, 가지 `feature/lane5-W12-merch-replay`, 출발점 `origin/develop` `1d78527e1`. W12-core-idem 계획 §13 **OPEN-B(가)**와 ADR-0337 '결과'의 남는 한계 둘째 줄, guidelines §4 '예외 둘째'가 출발점이다. 2026-11-22 감독이 OPEN-B(가)를 골랐다.
- **차례**: 시험 먼저. 계획 → 시험(구현 전 트리에서 실패 확인) → 구현 → 리뷰(보안 관점) → 리뷰 반영(시험 먼저) → 검증(틀린 구현 표본) → 기록. 커밋 꼬리말에 `Role`·`Agent-Session`·`Agent-Model: deepseek-v4.1-flash`·`Batch: W12-merch-replay`를 단다.
- **정본**: [ADR-0352](../../adr/0352-merch-payment-replay-rebuilds-checkout.md)(새), [ADR-0337](../../adr/0337-core-idempotency-record-role-row-security.md) 결정 6·'결과' 남는 한계, [ADR-0146](../../adr/0146-data-retention-gaps-idempotency-records-log-retention.md) 결정 1, [ADR-0299](../../adr/0299-merch-payments-order-kind-nullable-event-id.md) 결정 3, [ADR-0300](../../adr/0300-merch-order-stock-reservation-first-implementation.md) 결정 5, [guidelines](../../api/guidelines.md) §4 '예외 둘째', [data.md](../../data.md) '서비스마다 둔 멱등 기록 표', [payment.md](../../features/payment.md) §6 '굿즈 결제대금예치·가상계좌의 첫 구현'·§11 **P-T77**, [openapi](../../api/openapi.yaml) `createShopOrderPayment`·`PaymentAttempt`, [payment.proto](../../api/proto/peaket/payment/v1/payment.proto) `PrepareCheckoutRequest.pinned_pg`, [asvs/payment](../../security/asvs/payment.md) 8.2.2, [W12-core-idem 계획](W12-core-idem.md) §13.

## 결과 요약

| 위험 | 지금(출발점) | 이 묶음 뒤 | 남는 것 |
| --- | --- | --- | --- |
| 다른 상점 결제창 | 결과 참조의 `clientKey`·`successUrl`을 바꾸면 재생이 그대로 돌려준다 | 결과 참조에 결제창 값이 없다. 재생은 지금 설정으로 다시 만든다 | 주문·시도 행 자체를 바꾸는 공격은 남는다(§12) |
| 공개 키 출처 바뀜 | 저장된 옛 공개 키로 결제창이 열린다 | 재생은 지금 서버 설정의 공개 키·돌아올 주소를 쓴다 | 결제사 설정 자체가 틀리면 첫 요청도 틀린다(설정 관리 몫) |
| 재생이 다른 시도·다른 결제사로 감 | 대조는 시도 ID·결제사·금액만 본다 | 시도 행이 경로 주문·세션 계정의 것이 아니면 404, 재생이 만든 결제사·금액·주문이 어긋나면 503 | 같은 계정 안 다른 주문의 시도는 404로 막는다 |
| 재생 중 결제창 준비 실패 | 저장값을 돌려줘 실패를 숨긴다 | 503이고 같은 키로 다시 보낼 수 있다. 쓰기 0 | 없음 |
| 배포 창 | - | 옛 JSON 참조는 안의 시도 ID만 읽어 새 길로 재생한다 | 새 UUID 참조를 옛 파드가 읽으면 404(§12) |

## 1. 조사 결과

### 1.1 지금 저장하는 것과 재생 경로

- `services/core-svc/src/modules/shop/application/merch-payment.ts` 57~105행 `start`: `PrepareCheckout` → `store.saveAttempt(once, { …, responseJson: JSON.stringify(view) })`. 111~120행 `#startReplay`가 `attemptViewOf(ref)`로 JSON을 읽고, 경로 주문·계정·시도 행의 주문·결제사·결제창 금액을 견준 뒤 **view를 그대로** 돌려준다.
- `services/core-svc/src/modules/shop/adapters/db/drizzle-merch-orders.ts` 460~474행 `saveAttempt`: `resultRef: a.responseJson`. 327~340행 `replayOf`: `idempotency_record.result_ref`를 그대로 돌려준다.
- `services/core-svc/src/modules/shop/adapters/memory-merch-orders.ts` 295~306행도 `#remember(once, a.responseJson)`.
- 결과 참조 모양(openapi `PaymentAttempt.checkout`):

| 결제사 | 결과 참조에 지금 드는 값 |
| --- | --- |
| 토스·시뮬레이터 | `clientKey`, `customerKey`, `orderId`, `orderName`, `amount`, `successUrl`, `failUrl`, (에스크로) `escrowProducts` |
| 포트원 | `storeId`, `channelKey`, `paymentId`, `orderName`, `totalAmount`, `currency`, `redirectUrl`, `customData.orderId` |

- 시도 행(`merch_payment_attempt`)에는 이미 재생에 필요한 사실이 있다: `id`(시도 ID), `order_id`, `pg`, `pay_method`, `attempt_no`, `status`, `created_at`. 주문 행(`merch_order`)에는 `account_id`, `amount`, `event_id`, `pg_store`, `stock_reserved_until`이 있고, 항목은 `merch_order_item`에 있다.
- payment-svc `PrepareCheckout`은 `pinned_pg`(proto 12)를 이미 받는다. 값이 있으면 전환·지정을 보지 않고 그 결제사로 값을 만들고, 쓸 수 없으면 `UNAVAILABLE`이다(`services/payment-svc/src/modules/payment/application/prepare-checkout.ts` 66~107행). 티켓 결제 시도 재생이 같은 칸을 쓴다(`services/purchase-svc/src/modules/booking/application/start-payment.ts` 196~214행).
- core-svc gRPC 어댑터 `GrpcMerchPayments.prepareCheckout`은 `pinned_pg`를 아직 보내지 않는다(`services/core-svc/src/modules/shop/adapters/grpc-payment.ts` 101~135행).

### 1.2 재생 대조가 보는 것(ADR-0337 결정 6)

| 작업 | 결과 참조 | 대조 |
| --- | --- | --- |
| `START_MERCH_PAYMENT` | 처음 응답 JSON | JSON을 읽을 수 있고, 시도 ID가 경로 주문의 시도이며 그 주문의 계정이 세션 계정이고, 결제사가 그 시도의 결제사이고, 결제창 금액이 주문 금액이다 |

- 대조가 보지 않는 칸: 결제사 공개 키, 돌아올 주소의 출처, 주문명, 구매자 키. 그래서 ADR-0337 '결과'의 남는 한계 둘째 줄이 "팬 경로의 잘못된 쿼리가 ... 바꾸면 재생 대조가 잡지 못한다"고 적었다. 이 묶음이 그 한계를 닫는다.
- 대조 뒤에도 `view`를 그대로 돌려주므로, 대조를 지나온 값이라도 **저장된** 공개 키·주소다. 지금 설정과 다를 수 있다.

### 1.3 티켓 결제 시도의 재생 꼴(맞출 틀)

- `StartPayment.#replay`: 결과 참조는 시도 ID다. `reads.attempt(attemptId)`로 시도 행을 읽고, 주문을 읽어 구매 세션을 대조하고, `checkouts.prepare(query(…, attempt.attemptId, attempt.pg))`로 결제창 값을 다시 만든다. `PrepareCheckout`이 실패하면 5xx(수단 불가도 `PG_UNAVAILABLE` 503)이고 같은 키로 다시 보낸다. 저장한 응답 바이트는 없다.
- 굿즈도 같은 꼴로 맞춘다. 다른 점은 (가) 세션 대신 계정으로 소유를 보고, (나) 에스크로 상점·에스크로 상품·굿즈 복귀 주소를 다시 계산하며, (다) 응답에 `holdExpiresAt`(재고 예약 만료)을 싣는다는 것이다.

### 1.4 배포 호환

- 새 코드는 결과 참조에 시도 ID(UUID)를 쓴다. 이 묶음 이전 코드는 `attemptViewOf`가 JSON을 읽으므로 새 UUID를 읽지 못해 404로 답한다. 새 코드는 옛 JSON 참조를 읽을 때 **안의 `attemptId`만** 꺼내 새 길로 재생한다(저장된 다른 값은 버린다). 그래서 옛 키의 재시도는 배포 창에도 이어지고, 새 키의 재시도만 옛 파드에 닿으면 404다(파드 교체 동안의 짧은 창, §12).
- 마이그레이션은 없다. 표·칸·권한을 바꾸지 않는다.

## 2. 목표와 비목표

- **목표**
  1. `START_MERCH_PAYMENT`의 `idempotency_record.result_ref`가 시도 ID 하나다. 결제사 공개 키·구매자 키·돌아올 주소·금액·`checkout` 글자가 기록에 없다.
  2. 같은 멱등키 재생은 저장값을 돌려주지 않고 `PrepareCheckout`을 같은 시도 ID·같은 결제사(pinned)·같은 주문 금액으로 다시 불러 지금 설정 값으로 결제창을 다시 만든다.
  3. 재생의 시도 ID가 경로 주문·세션 계정의 것이 아니면 남의 주문과 같은 404이고, `PrepareCheckout`·쓰기 0이며 SEV2 로그 한 줄이다.
  4. 재생 중 `PrepareCheckout`이 실패하면 5xx이고 아무것도 바뀌지 않으며 같은 키로 다시 보낼 수 있다.
  5. 재생이 만든 결제사·금액·주문 ID가 시도·주문과 다르면 결제창 값을 돌려주지 않는다(다른 상점·다른 금액으로 보내지 않는다).
  6. 정본(ADR-0352, ADR-0337, guidelines §4, data.md, payment.md §11 P-T77, openapi 설명, asvs/payment 8.2.2)이 코드와 같은 말을 한다.
- **비목표**
  - `START_MERCH_PAYMENT` 밖의 여섯 굿즈 작업 재생(주문·부가 상품·결제 접수·취소·환급 계좌 다시 받기·반품)의 꼴. 그 작업들의 결과 참조는 그대로 둔다.
  - 주문·시도 행의 무결성(서명·해시·칸 권한). `merch_order`·`merch_order_item`의 `core_partner` 표 단위 고치기(W12-core-idem §14 높음 후보)는 다른 묶음이다.
  - 티켓 결제 시도(purchase-svc)의 재생 변경.
  - 결제사 공개 키 설정 관리, 결제창 문구·화면.
  - 새 마이그레이션·새 표·새 지표.
  - `core_app`의 멱등 기록 표 권한 회수(ADR-0337이 정한 그대로).

## 3. 완료의 정의

1. 새 시험 P-T77 ①~⑤가 구현 전 트리에서 실패하고, 구현 뒤 실제 PostgreSQL 18 컨테이너에서 통과한다.
2. `idempotency_record.result_ref`가 시도 ID와 같고, 그 행 어디에도 `clientKey`·`customerKey`·`successUrl`·`failUrl`·`redirectUrl`·`totalAmount`·`"checkout"`이 없다.
3. 같은 키 재생이 `PrepareCheckout`을 한 번 더 부르고, 그 요청의 `attempt_id`·`pinned_pg`·금액이 처음 시도·주문과 같다. 응답의 공개 키·구매자 키·돌아올 주소는 지금 설정(바뀐 값)이다.
4. 재생 대조 실패는 404·`PrepareCheckout` 0·쓰기 0·SEV2 로그 한 줄이고, `PrepareCheckout` 실패는 503·쓰기 0·기록 그대로이며, 같은 키 재시도가 성공한다.
5. 단위·대상 통합·typecheck·lint·doc-check·`trace-check --ids "P-T77"`·`ledger --batch W12-merch-replay --require`가 통과한다.
6. 리뷰(보안)·검증(틀린 구현 표본 7개 이상)·기록(R-760)이 채워지고 `roles-check --base origin/develop --head HEAD`·`records.mjs --check`가 통과한다.

## 4. 엣지와 실패 시나리오

| 상황 | 기대 |
| --- | --- |
| 처음 결제 시도 | 201, 결제창 값, `result_ref` = 시도 ID |
| 같은 키·같은 본문 재생 | 201, 같은 시도 ID·결제사·주문·금액, 새로 만든 공개 키·구매자 키·돌아올 주소 |
| 응답의 공개 키를 바꾼 옛 기록 | 새 코드는 기록의 공개 키를 쓰지 않고 지금 설정으로 다시 만든다 |
| 옛 JSON 결과 참조(배포 전 기록) | 안의 `attemptId`만 읽어 새 길로 재생한다. 저장된 공개 키·주소·금액은 돌려주지 않는다 |
| 결과 참조가 같은 팬 다른 주문의 시도 | 404 not-found(남의 주문과 같은 본문), `PrepareCheckout` 0, 쓰기 0, SEV2 로그 한 줄 |
| 결과 참조가 다른 팬의 시도 | 404, 위와 같다 |
| 경로 주문이 다른 팬의 것 | 404, 위와 같다 |
| 시도 행의 `order_id`만 다른 주문으로 바뀜 | 404, 위와 같다 |
| 결과 참조가 UUID도 JSON도 아님 | 404, 위와 같다 |
| 재생 중 `PrepareCheckout`이 `unavailable` | 503 pg-unavailable, 쓰기 0, 같은 키로 다시 가능 |
| 재생 중 `PrepareCheckout`이 `invalid`(수단 불가) | 503 pg-unavailable(첫 요청의 400이 아니다), 쓰기 0 |
| 재생 중 `PrepareCheckout`이 `paused`(채널 없음·비활성) | 503 new-payment-paused, 쓰기 0 |
| 재생 중 `PrepareCheckout`이 `error`(설정 오류) | 503 dependency-unavailable, 쓰기 0 |
| 재생이 돌려준 `pg`가 시도 행과 다름 | 503 dependency-unavailable, 결제창 값 0, SEV2 로그 한 줄 |
| 재생이 돌려준 결제창 금액이 주문 금액과 다름 | 503 dependency-unavailable, 결제창 값 0, SEV2 로그 한 줄 |
| 재생이 돌려준 결제창 주문 ID가 경로 주문과 다름 | 503 dependency-unavailable, 결제창 값 0, SEV2 로그 한 줄 |
| 같은 키·다른 본문 | 422 idempotency-key-reused(플랫폼 규칙, 이 묶음이 바꾸지 않는다) |
| 새 UUID 참조를 옛 파드가 읽음 | 404(배포 창의 남는 위험, §12) |

## 5. 인터페이스 계약

| 이름 | 값·모양 | 정하는 곳 |
| --- | --- | --- |
| `START_MERCH_PAYMENT` 결과 참조 | `merch_payment_attempt.id`(소문자 UUIDv7) 하나. 결제창 값·금액·주소 없음 | ADR-0352 결정 1, data.md |
| 옛 결과 참조(호환) | JSON이면 `attemptId` 글자만 읽는다. 다른 칸은 무시 | ADR-0352 결정 6 |
| 재생 입력 | `orderId`(경로), `accountId`(세션), `attemptId`, `attempt.pg`, `attempt.payMethod`, `order.amount`, `order.orderName`(항목 이름), `order.pgStore`, 에스크로 상품 | ADR-0352 결정 2·3 |
| `PrepareCheckout` 추가 칸 | `CheckoutQuery.pinnedPg?: ShopPg` → proto `pinned_pg` | ADR-0352 결정 3, payment.proto |
| 재생 응답 | openapi `PaymentAttempt` 그대로. `attemptId`·`pg`·`checkout`(지금 설정) ·`allowedPayMethods`·`depositDueAt`·`holdExpiresAt`(주문의 지금 예약 만료) | ADR-0352 결정 5, openapi |
| 대조 실패 | 404 `not-found`, 로그 `kind=idempotency-replay-mismatch`·`severity=SEV2`·`operation`·`orderId` | ADR-0337 결정 6, ADR-0352 결정 2 |
| 재생 불일치(내부) | 503 `dependency-unavailable`, 로그 `kind=merch-checkout-replay-mismatch`·`severity=SEV2`·`orderId`·`field`(pg·amount·orderId) | ADR-0352 결정 4 |
| 재생 준비 실패 | 503 `pg-unavailable`·`new-payment-paused`·`dependency-unavailable`, 같은 키 재시도 가능 | ADR-0352 결정 5 |
| 시험 ID | `P-T77` ①~⑤ | payment.md §11 |

## 6. 보안 위협과 운영 확인

| 위협 | 누가 어떻게 | 이 묶음의 막이 | 남는 것 |
| --- | --- | --- | --- |
| 다른 상점 결제창 | 팬 경로 쿼리·DB 쓰기로 결과 참조의 공개 키·돌아올 주소를 바꿈 | 결과 참조에 그 값이 없다. 재생은 지금 설정으로 다시 만든다 | 주문·시도 행 자체를 바꾸는 공격은 남는다(§12) |
| 공개 키 바뀜 | 서버 설정의 공개 키가 바뀌었는데 옛 기록이 옛 키를 돌려줌 | 재생이 지금 설정으로 다시 만든다 | 설정 자체가 틀리면 첫 요청도 틀린다(설정 관리) |
| 다른 시도·다른 결제사 | 결과 참조를 다른 주문의 시도로 바꿈 | 시도 행이 경로 주문·계정의 것인지 보고, pinned 결제사로만 만든다 | 같은 계정의 같은 주문 안 다른 시도는 같은 금액·주문이라 위험이 작다 |
| 결제사 전환 | 재생이 다른 결제사로 값을 만듦 | `pinned_pg` + 응답 `pg` 대조, 어긋나면 503 | 없음 |
| 금액 바꿈 | 재생이 다른 금액으로 값을 만듦 | 결제창 금액 대조, 어긋나면 503 | 주문 행 자체의 금액 변조는 남는다(§12) |
| 재생 실패를 성공으로 숨김 | `PrepareCheckout` 실패 때 저장값 반환 | 실패는 5xx이고 아무것도 쓰지 않는다 | 없음 |
| 기록에서 값 읽기 | 다른 역할·다른 계정이 `result_ref`를 읽음 | 이제 시도 ID뿐이다(ADR-0337 행 보안과 함께) | 시도 ID로 결제창 값을 만들 수는 있지만, 소유·경로 대조를 지나야 한다 |

**운영 확인 표(docs/architecture.md §8.4)**

| 확인할 것 | 신호·지표(로그 필드·요청 값) | SLI(측정값) | 임계치·알림 | 대응(런북·자동화) | 배포 뒤 확인 시점 |
| --- | --- | --- | --- | --- | --- |
| 재생 대조 실패가 없다 | 오류 로그 `kind=idempotency-replay-mismatch`, `operation=START_MERCH_PAYMENT`, `orderId` | 5분 동안 그 로그 수 | 1건 이상이면 SEV2 알림 | `idempotency_record.result_ref`의 시도 ID와 `merch_payment_attempt.order_id` 대조, 배포 창 여부 확인 | 배포 직후 30분 |
| 재생 준비 실패가 없다 | 오류 로그 `kind=merch-checkout-replay-mismatch`(field), HTTP 503 `pg-unavailable`·`new-payment-paused`·`dependency-unavailable` | 5분 동안 재생 503 수 | 1% 초과가 5분 지속이면 알림 | payment-svc `PrepareCheckout`·채널·설정 확인, 같은 키 재시도 안내 | 배포 직후 30분 |
| 결제창 값이 기록에 없다 | `select result_ref from idempotency_record where operation='START_MERCH_PAYMENT'` 표본 | `result_ref`가 UUID가 아닌 행 수 | 20건 넘으면 알림 | 옛 JSON 행은 24시간 안에 사라진다. 새 행이 JSON이면 회귀 | 배포 직후 1시간, 다음 날 1회 |
| 재생이 지금 공개 키를 쓴다 | 재생 응답의 `checkout.clientKey`·`successUrl`과 payment-svc 설정 값 | 표본 5건의 일치 | 1건이라도 다르면 알림 | payment-svc 설정·배포 판 확인 | 배포 직후 1시간 |

## 7. 손댈 파일과 담당

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 계획 | `docs/review/plans/W12-merch-replay.md`(새), `docs/adr/0352-merch-payment-replay-rebuilds-checkout.md`(새), `docs/features/payment.md` §11 P-T77, `docs/BUILD_ORDER.md` 묶음 줄, `docs/review/ledger-notes.md` P-T77 줄 | 결정·시험 ID·장부 범위 먼저 |
| 시험 | `services/core-svc/test/merch-payment-replay.test.ts`(새) | P-T77 ①~⑤(메모리) |
| 시험 | `services/core-svc/test-int/shop-replay.int.test.ts` | P-T77 ①~⑤(실제 PostgreSQL), 기존 AZ-T17 ⑥ 결제 시도 시험을 새 참조 꼴로 고침 |
| 시험 | `services/core-svc/test/shop-replay-in-tx.test.ts` | 결제 시도 트랜잭션 안 재생을 새 참조 꼴로 고침 |
| 시험 | `services/payment-svc/test-int/merch-path-e2e.int.test.ts` | P-T77 ②(실제 gRPC `PrepareCheckout`·pg-simulator) |
| 구현 | `services/core-svc/src/modules/shop/domain/merch-ports.ts` | `NewAttempt`에서 `responseJson` 제거, `CheckoutQuery.pinnedPg` |
| 구현 | `services/core-svc/src/modules/shop/application/merch-payment.ts` | 결과 참조 = 시도 ID, 재생이 다시 만듦, 대조·5xx·불일치 가드 |
| 구현 | `services/core-svc/src/modules/shop/adapters/db/drizzle-merch-orders.ts`, `adapters/memory-merch-orders.ts` | `resultRef: attemptId` |
| 구현 | `services/core-svc/src/modules/shop/adapters/grpc-payment.ts` | `pinned_pg` 전송 |
| 구현 | `docs/api/openapi.yaml` `createShopOrderPayment` 설명, `docs/api/guidelines.md` §4 '예외 둘째', `docs/data.md` 멱등 기록 표 문단, `docs/features/payment.md` §6, `docs/security/asvs/payment.md` 8.2.2, ADR-0337 '결과' | 정본 문장·생성물 |
| 구현 | `packages/contracts`·`packages/api-client` 생성물 | `gen`(설명만 바뀌면 변화 없음 확인) |
| 리뷰 | 이 계획 `## 리뷰` | RV-01… |
| 검증 | 이 계획 `## 검증` | 표본·명령·결과 |
| 기록 | 이 계획, `docs/00-summary.md`, `docs/review/consistency-review.md`, `docs/lanes/lane5.md`, `docs/wbs/wbs.csv`·`wbs.md` | R-760 |

- 구현 커밋은 시험 파일을 바꾸지 않는다. 시험 커밋은 제품 코드를 바꾸지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: 적용된 마이그레이션(0027·0033·0041), `packages/platform`, 굿즈 다른 여섯 작업의 결과 참조, 계약의 응답 모양(설명만 고친다), 화면.

## 8. 시험 목록(P-T77, 시험 담당)

- **단위(메모리)**: `services/core-svc/test/merch-payment-replay.test.ts`. `MemoryShopOrderStore`·`MemoryMerchPayments`를 쓰고, 결제사 대역은 `prepareCheckout`을 덮어써 호출마다 다른 공개 키·구매자 키·돌아올 주소를 준다. `idempotency` 맵의 `resultRef`를 직접 읽어 기록을 본다.
- **통합(실제 PostgreSQL 18)**: `services/core-svc/test-int/shop-replay.int.test.ts`의 P-T77 묶음. core_app 로그인, AppModule DB 조립, 결제는 `MemoryMerchPayments`(부른 기록), 재고는 `MemoryMerchStock`. `admin`으로 `idempotency_record.result_ref`를 읽고 바꾼다. `payment_svc` 실패는 대역의 `checkoutFailure`로 만든다.
- **실제 연결(payment-svc gRPC·pg-simulator)**: `services/payment-svc/test-int/merch-path-e2e.int.test.ts`에 P-T77 ②를 더한다. core-svc HTTP → 실제 `GrpcMerchPayments` → 실제 `PrepareCheckout` → 시뮬레이터 어댑터. 같은 키 재생이 `customerKey`를 새로 만들고, 그 응답으로 접수·승인까지 간다.

| 시험 이름 | 단언 | 구현 전 트리 |
| --- | --- | --- |
| `P-T77 ① 처음 굿즈 결제 시도는 결제창 값을 돌려주고 멱등 기록에는 시도 ID만 남긴다 [ASVS v5.0.0-8.2.2]` | 201, `checkout` 값이 있고 금액 = 주문 금액. `idempotency_record.result_ref` = `attemptId`이고 `clientKey`·`customerKey`·`successUrl`·`failUrl`·`redirectUrl`·`totalAmount`·`"checkout"`이 없다. `paymentAttempt(result_ref)`가 그 주문의 시도다 | 실패(기록이 응답 JSON) |
| `P-T77 ② 같은 멱등키 재생은 PrepareCheckout을 같은 시도 ID·결제사로 다시 불러 지금 설정 값으로 결제창을 다시 만든다 [ASVS v5.0.0-8.2.2]` | 첫 응답 뒤 대역의 공개 키·돌아올 주소·구매자 키를 바꾼다. 재생 201, `payments.calls.checkout`이 1 늘고 마지막 호출의 `attemptId` = 처음 시도, `pinnedPg` = 시도 결제사, 금액 = 주문 금액, `payMethod`·`pgStore`·에스크로 상품이 처음과 같다. 응답의 `clientKey`·`successUrl`·`customerKey`는 바뀐 값(저장값 아님). 시도·기록·쓰기 수 그대로. 옛 JSON 참조의 공개 키·주소도 돌려주지 않는다 | 실패(저장 JSON 반환·`PrepareCheckout` 0) |
| `P-T77 ③ 재생의 시도 ID가 경로 주문·세션 계정의 것이 아니면 404 not-found이고 PrepareCheckout을 부르지 않는다 [ASVS v5.0.0-8.2.2]` | (가) 같은 팬 다른 주문의 시도 (나) 다른 팬의 시도 (다) 없는 UUID (라) UUID·JSON이 아닌 글 (마) 시도 행 `order_id`를 다른 주문으로 바꿈 (바) 경로 주문이 다른 팬의 것 — 모두 404가 남의 주문 404와 같고, `checkout` 호출 0, 쓰기 0, SEV2 로그 한 줄(계정 ID·참조 원문·시도 ID 없음). 옛 JSON에 다른 주문의 시도가 들면 역시 404이고 저장값이 응답에 없다 | 실패(JSON 참조의 다른 시도가 201) |
| `P-T77 ④ 재생 중 PrepareCheckout이 실패하면 5xx이고 아무것도 바꾸지 않으며 같은 키로 다시 시도할 수 있다 [ASVS v5.0.0-8.2.2]` | `unavailable` → 503 `pg-unavailable`, `invalid` → 503 `pg-unavailable`, `paused` → 503 `new-payment-paused`, `error` → 503 `dependency-unavailable`. 각각 쓰기·시도·`result_ref` 그대로. 실패를 지우고 같은 키로 다시 부르면 201이고 `checkout` 호출이 1 늘어난다 | 실패(저장 JSON 201) |
| `P-T77 ⑤ 재생이 만든 결제사·금액·주문 ID가 시도·주문과 다르면 결제창 값을 돌려주지 않고 503 dependency-unavailable이다 [ASVS v5.0.0-8.2.2]` | 대역이 `pg` TOSS(시도 SIMULATOR), 금액 +1,000원, 다른 주문 ID를 돌려줄 때 각각 503 `dependency-unavailable`, 응답에 `checkout` 없음, 쓰기·기록 그대로, SEV2 로그 `kind=merch-checkout-replay-mismatch`·`field`(pg·amount·orderId) 한 줄(값 없음). 시도 행 `pg`를 TOSS로 바꾼 재생도 503 | 실패(저장 JSON 201) |

- **회귀**: `test/shop-replay-in-tx.test.ts` 나머지 여섯 작업, `test-int/shop-replay.int.test.ts` AZ-T17 ⑥ 나머지, `test-int/shop-order.int`, `shop-cancel.int`, `shop-expiry.int`, `shop-refund-account.int`, `shop-return.int`, `test/shop-order.http`, `test/shop-start-assembly`, `test-int/idempotency-rls.int`, `test-int/idempotency-migration.int`, payment-svc `merch-path-e2e.int` P-T57.
- **시험 값**: 가격 16,700원, 공개 키 `test_ck_first`/`test_ck_second`, 돌아올 주소 `https://first.example`/`https://second.example`, 구매자 키 `buyer-first`/`buyer-second`(코드 기본값과 다르게).
- **이름 규칙**: ID 바로 뒤에 세부 번호를 둔다(`P-T77 ①_…`). 장부는 이 이름으로 찾는다.

## 9. 틀린 구현 표본(검증 담당)

기준선은 구현 뒤 트리에서 P-T77 ①~⑤ 통과. 표본마다 하나만 넣고 돌린 뒤 `git checkout -- <파일>`.

| # | 항목 | 넣을 곳 | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- | --- |
| M1 | ② | `merch-payment.ts` | 재생이 저장한 응답 JSON을 그대로 돌려준다(지금 코드) | ②(바뀐 공개 키·주소가 안 나옴), ①(기록이 JSON) |
| M2 | ③ | `merch-payment.ts` | 재생이 `attempt.orderId === 경로 주문`을 보지 않는다 | ③(다른 주문의 시도가 201) |
| M3 | ④ | `merch-payment.ts` | 재생의 `CheckoutFailed`를 200/저장값으로 바꾼다 | ④(503 기대, 201) |
| M4 | ⑤ | `merch-payment.ts` | 재생이 결제창 금액을 주문 금액과 견주지 않는다 | ⑤(금액 +1,000원이 201) |
| M5 | ① | `drizzle-merch-orders.ts`·`memory-merch-orders.ts` | `resultRef`에 `JSON.stringify(view)`를 넣는다 | ①(기록에 공개 키·주소) |
| M6 | ②·⑤ | `merch-payment.ts`·`grpc-payment.ts` | 재생이 `pinnedPg`를 넘기지 않는다 | ②(`pinnedPg` 단언), ⑤(다른 결제사가 201) |
| M7 | ③ | `merch-payment.ts` | 재생이 계정 대조를 뺀다 | ③(다른 팬의 시도가 201) |
| M8 | ② | `merch-payment.ts` | 옛 JSON 참조의 저장된 `checkout`을 그대로 돌려준다 | ②(옛 JSON의 옛 공개 키·주소) |

- 항목마다 수: ① 2, ② 3, ③ 2, ④ 1, ⑤ 2. 7개 이상을 돌린다.
- '검증' 절에 적을 것: 표본마다 실패한 시험, 놓친 표본과 시험 담당에게 넘긴 것, P-T77 ①~⑤ 판정 기준과 단언의 대조 전수.

## 10. 게이트 명령과 닿는 CI 잡

```bash
cd /d/ticketpass-lane5
corepack pnpm exec turbo run build --filter=@peaket/core-svc^...
corepack pnpm --filter @peaket/core-svc typecheck
corepack pnpm --filter @peaket/core-svc test
PEAKET_TEST_REPORT=test-report-int.json corepack pnpm --filter @peaket/core-svc test:integration test-int/shop-replay.int.test.ts test-int/shop-order.int.test.ts test-int/shop-cancel.int.test.ts test-int/shop-expiry.int.test.ts test-int/shop-refund-account.int.test.ts test-int/shop-return.int.test.ts test-int/idempotency-rls.int.test.ts test-int/idempotency-migration.int.test.ts
PEAKET_TEST_REPORT=payment-test-report-int.json corepack pnpm --filter @peaket/payment-svc test:integration test-int/merch-path-e2e.int.test.ts
corepack pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "P-T77" --report services/core-svc/test-report-int.json --report services/payment-svc/payment-test-report-int.json
node tools/ci/ledger.mjs --batch W12-merch-replay --require
node tools/ci/records.mjs --check
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
```

| 잡 | 왜 |
| --- | --- |
| `ci.yml` → `ci-node.yml` / node | core-svc typecheck·단위·통합, payment-svc 통합 |
| `docs-check` | ADR-0352·payment.md·guidelines·data.md·asvs·openapi 설명 |
| `lint-guard` | core-svc 어댑터·포트 주석, 계약 생성물 |
| `contract-check` | openapi 설명 → `packages/contracts`·`packages/api-client` 생성물 |
| `tools-check` | 장부·기록·역할 검사 |

- Docker 잠금: `C:\Program Files\Git\bin\bash.exe /d/ticketpass-locks/lock.sh take docker lane5-W12-merch-replay`, 시험 뒤 `drop`, peaket 컨테이너 0.
- Docker가 막히면 초안 PR CI로 같은 파일을 돌린다(ADR-0283 결정 3). 이 묶음은 Docker 잠금을 잡고 한다.

## 11. 자주 놓친 결함 가운데 해당하는 것

- 정확한 값까지: ②는 `pinnedPg`·금액·`payMethod`·`pgStore`·에스크로 상품을 호출 값으로, ⑤는 응답에 `checkout`이 없는 것까지 본다.
- 경계·세 상태: ③은 시도 없음·다른 주문·다른 계정·UUID 아님·시도 행 변조, ④는 네 가지 `CheckoutFailed` 갈래.
- 겹친 가드 하나씩: 시도 ID의 주문 대조(③)와 응답의 결제사·금액 대조(⑤)를 따로, 재생 실패(④)와 불일치(⑤)를 따로.
- 목록 밖 값마다: 결과 참조 모양(UUID·옛 JSON·JSON 아님·다른 JSON), `CheckoutFailed` 네 갈래, 불일치 칸 셋.
- 부르는 쪽이 결과를 쓰는지: ②는 응답을, ③④⑤는 쓰기·`PrepareCheckout` 호출 수를 함께 본다.
- 시험 값은 코드 기본값과 다르게(가격 16,700원, 공개 키·주소·구매자 키 두 벌).
- 로그에 계정 ID·결과 참조 원문·시도 ID·결제창 값이 없다.

## 12. 범위 밖과 넘기는 것

- **넘기는 것**:
  - 주문·시도 행의 무결성. `core_app`은 `merch_order`·`merch_order_item`에 표 단위 고치기 권한이 있고(W12-core-idem §14 '높음 후보(돈)'), 재생은 이제 주문 금액·시도 결제사를 그 행에서 읽는다. 그 행을 바꾸는 공격은 이 묶음이 닫지 못한다. 파트너 경로 역할의 표 단위 권한을 줄이는 새 묶음이 맡는다.
  - 배포 창: 새 UUID 참조를 옛 파드가 읽으면 404다. 파드 교체가 끝나면 사라진다. 옛 JSON 참조는 새 코드가 읽는다.
  - `START_MERCH_PAYMENT` 밖 여섯 작업의 결과 참조 모양.
  - 결제사 공개 키 설정 관리(Secrets Manager·배포 값).
  - 새 지표(로그로 본다, §6).
- **남는 위험**: 위 두 가지. 리뷰·검증·기록에 적는다.

## 13. WBS 일 [가정]

0.6일 = 계획 0.1 + 시험 0.2(단위 파일 하나, 통합 P-T77 다섯, 실제 연결 하나) + 구현 0.15(포트·재생·어댑터 둘·정본·생성물) + 리뷰 0.05 + 검증 0.1(표본 8개) + 기록 0.05. 감독이 coord.md에 적는다.

## 실패 확인

시험 담당이 구현 전 트리에서 채운다.

## 리뷰

리뷰 담당(보안 관점)이 채운다.

## 검증

검증 담당이 채운다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-w12merchreplay-plan | deepseek-v4.1-flash | 2026-11-22T12:00+09:00 | 2026-11-22T12:40+09:00 |
| test | lane5-w12merchreplay-test | deepseek-v4.1-flash | 2026-11-22T12:40+09:00 | 2026-11-22T13:30+09:00 |
| impl | lane5-w12merchreplay-impl | deepseek-v4.1-flash | 2026-11-22T13:30+09:00 | 2026-11-22T14:20+09:00 |
| review | lane5-w12merchreplay-review | deepseek-v4.1-flash | 2026-11-22T14:20+09:00 | 2026-11-22T14:40+09:00 |
| verify | lane5-w12merchreplay-verify | deepseek-v4.1-flash | 2026-11-22T14:40+09:00 | 2026-11-22T15:20+09:00 |

## 감독에게

1. **경로 정정**: 굿즈 결제 시도(`merch-payment.ts`)와 그 멱등 기록은 `services/core-svc`에 있고, payment-svc는 `PrepareCheckout`(결제창 값 만들기)만 맡는다. 그래서 시험은 core-svc 단위·통합과 payment-svc `test-int/merch-path-e2e`(실제 gRPC·pg-simulator)에 둔다.
2. **번호**: ADR **0352**, 시험 **P-T77**(payment.md §11의 다음 빈 번호). 0350·0351은 다른 세션 몫이다. `docs/lanes/coord.md`의 웨이브 12 표에 ADR 0352와 P-T77 머리를 감독이 더해 달라.
3. **ADR 0289가 없다**: 지시에 있던 ADR 0289(멱등 기록)는 이 저장소에 없다. 멱등 기록의 정본은 ADR-0146 결정 1·ADR-0337이고, 굿즈 결제는 ADR-0299·0300이다.
4. **범위 확인**: `START_MERCH_PAYMENT` 하나만 바꾼다. 다른 여섯 굿즈 작업의 결과 참조는 그대로다.
5. **배포**: 마이그레이션 없음. 새 코드는 옛 JSON 참조를 읽지만, 새 UUID 참조를 옛 파드가 읽으면 404다(파드 교체 창). 카나리 배포를 권한다.
