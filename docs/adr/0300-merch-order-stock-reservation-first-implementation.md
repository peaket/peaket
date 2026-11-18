# ADR-0300: 굿즈 주문·한정 재고·재고 예약의 첫 구현(2026-11-18)

- **상태**: 채택(2026-11-18, 추천 적용. 갈래 5 BAT-600 계획 담당이 LCH-010의 정본 빈칸으로 정했다. 방향은 [ADR-0101](0101-product-catalog-postgres-jsonb-drop-mongodb.md)(상품 정의와 유형 스키마)과 [ADR-0107](0107-expire-unpaid-orders-ticket-expired-merch-stock-reservation.md) 결정 4(재고 예약 15분 [가정], 결제 접수 때 승인 기한까지 연장, 정렬 집합 쓸기, 같은 상품에 결제 전 주문 하나) 그대로이고, 그 안의 집행 세부를 정한다)
- **관련**: [ADR-0299](0299-merch-payments-order-kind-nullable-event-id.md)(굿즈 결제의 원장 길), [ADR-0301](0301-ticket-addons-fulfillment-unclaimed-auto-cancel.md)(부가 상품·수령 방식·미수령), [docs/data.md](../data.md) §2 `merch_order`·`product`·`product_stock`, §3 굿즈 재고 키, §4 경계 5, §5, [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §2.13, [docs/api/openapi.yaml](../api/openapi.yaml) `shop` 태그, [docs/features/payment.md](../features/payment.md) §11 P-T42·P-T56, [docs/verification.md](../verification.md) V-T46·§4.1, [docs/review/plans/BAT-600.md](../review/plans/BAT-600.md)
- **관련 ID**: P-T42, P-T56, V-T46, V-T26, FR-015, FR-024, NFR-025, BUILD_ORDER LCH-010

## 맥락

- core-svc shop에는 파트너 상품 등록·고치기(BAT-610)와 상품 정산 원천만 있다. 팬이 굿즈를 주문하고 결제하는 길, 한정 재고를 깎는 Redis(메모리에 데이터를 두는 빠른 저장소) 카운터, 결제하지 않은 주문의 재고 예약 만료가 없다. 상품 유형(`type`)은 아무 글자나 받고, 유형별 속성 검사와 매일 도는 속성 검증 잡이 없다.
- 지금 코드의 `merch_order.status`는 `PENDING`·`PAID`·`CANCELLED`·`REFUNDED`이다. 정본 상태도(docs/planning/03 §2.13 O1~O7)와 docs/data.md의 값은 `CREATED`·`AWAITING_DEPOSIT`·`PAID`·`EXPIRED`·`FAILED`이고, 취소·환급은 항목 상태(I2·I16)다. 정본이 이긴다.
- 티켓 주문의 결제 길(purchase-svc booking: 결제 시도 시작 → 결제 접수 → 승인 명령 → 결과 반영 → 만료)은 이미 있다. 굿즈는 같은 결제 포트를 쓰되 좌석 홀드·구매 세션이 없다.

## 결정

1. **상품 유형과 속성 검사(추천 적용).**
   - 참조 표 `product_type`(`code` 기본 키, `latest_schema_version`, `enabled`)을 만들고 마이그레이션으로 기본 유형 둘 `MERCH`(굿즈)·`PARKING`(주차권)을 판 1로 넣는다(V-T26의 '기본 유형 둘'). 셋째 유형 `VIP`는 V-T26이 재는 다음 변경이다(행 하나·스키마 판 하나·화면 설정, DDL 없음).
   - 유형마다 Zod 스키마(입력 모양 검사 라이브러리)를 `@peaket/validation`의 상품 유형 묶음에 판으로 둔다. 모든 유형이 같이 쓰는 칸은 `perAccountLimit`(계정당 최대 수량, 1~99 정수 또는 null, openapi `ShopProduct`)과 `options`(옵션 0~10개 [가정], 옵션마다 이름 1~30자와 고를 값 1~50개, 값은 1~50자, 이름·값 겹침 없음)다. `MERCH` 판 1은 이 둘만, `PARKING` 판 1은 여기에 `vehicleNotice`(차량 안내, 선택, 1~200자 [가정])를 더한다. 모르는 칸은 거절한다.
   - 파트너 상품 만들기·고치기는 유형이 표에 있고 켜져 있는지(아니면 422 `product-type-invalid`), 속성이 그 유형의 최신 판 스키마에 맞는지(아니면 422 `product-attributes-invalid`) 본다. 고치기는 합친 속성을 통째로 다시 검사하고 `schema_version`을 최신 판으로 적는다.
2. **속성 검증 잡(추천 적용).** core-svc 릴레이 프로세스의 정비 일 `product-attributes-check`가 매일 한 번(04:40 KST [가정], 정비 시간 안) 모든 상품을 기본 키 차례로 1,000건 [가정]씩 읽어 그 행의 유형·판 스키마로 다시 검사한다. 맞지 않는 상품(모르는 유형·판 포함)이 1건이라도 있으면 SEV3 경고 한 줄(`kind` hygiene, 상품 ID와 유형·판만, 속성 값은 싣지 않는다)과 게이지 `shop_product_attributes_invalid`(마지막 실행의 건수)를 낸다. 상품을 고치지 않는다.
3. **한정 재고의 Redis 키와 Lua(추천 적용).**
   - 세션·캐시 클러스터(core-svc 환경 값 `PEAKET_SHOP_REDIS_URL`)에 상품마다 같은 해시 슬롯(`{product:P}` 해시 태그)의 키 넷을 둔다. `shop:{product:P}:stock`(판매 가능 수 = `product_stock.stock` − 결제 접수 전 예약 수량 합), `shop:{product:P}:resv`(정렬 집합, 원소 주문 ID, 점수 = 예약 만료 시각 ms), `shop:{product:P}:resv_qty`(해시, 주문 ID → 수량), `shop:{product:P}:unpaid`(해시, 계정 ID → 결제 전 주문 ID). 네 키의 수명은 판매 종료 + 1일 [가정](판매 종료가 없으면 30일 [가정])이고 예약 Lua가 부를 때마다 다시 건다(모든 키에 TTL, docs/data.md §3).
   - 예약 Lua(`RESERVE`): `unpaid`에 그 계정의 다른 주문이 있으면 `PREV`와 그 주문 ID, 카운터가 없으면 `NO_COUNTER`, 모자라면 `SOLD_OUT`을 돌려주고 아무것도 바꾸지 않는다. 아니면 카운터를 깎고 `resv`·`resv_qty`·`unpaid`에 넣는다.
   - 풀기 Lua(`RELEASE`, 인자 `restore` 0·1): `resv`에서 그 주문을 지웠을 때만(ZREM이 1) `resv_qty`를 지우고, `restore`가 1이면 그 수량만큼 카운터를 돌린다. `unpaid`가 그 주문을 가리키면 지운다. 원소가 이미 없으면 아무것도 돌리지 않는다(두 번 돌리지 않는다).
   - 연장 Lua(`EXTEND`): 원소가 있으면 점수를 지금 값과 새 값 가운데 큰 것으로 바꾸고 `unpaid`에서 그 주문을 지운다(접수한 주문은 '결제하지 않은 주문'이 아니다). 원소가 없으면 0을 돌려준다.
   - 카운터가 없으면(키 수명 끝, Redis 재시작) 주문 만들기가 다시 만든다. DB에서 `product_stock.stock`과 결제 접수 전이고 예약이 끝나지 않은 `CREATED` 주문의 수량 합을 읽어, 카운터와 세 집합을 `SET … NX`와 같은 Lua 하나로 넣고 한 번만 다시 예약한다. 다시 만드는 동안 들어온 주문이 있어 값이 어긋나도 초과 판매는 결제 접수 때의 PostgreSQL 조건부 갱신(`stock >= quantity`, docs/data.md §4 경계 5)이 막는다.
   - 파트너가 한정 수량을 고치면 `product_stock.stock`을 '지금 남은 수 + (새 수량 − 옛 수량)'으로 바꾸고(음수면 422 `product-limited-qty-invalid`), 같은 트랜잭션이 끝난 뒤 그 상품의 카운터 키만 지운다(다음 주문이 다시 만든다). 지금 코드처럼 남은 수를 새 수량으로 덮어쓰지 않는다(이미 판 수량을 다시 팔게 된다).
4. **주문 만들기(`POST /v1/shop/orders`, 추천 적용).**
   - 팬 쿠키의 계정으로 받고 `Idempotency-Key`를 플랫폼 멱등 모듈로 다룬다. 한 판매자·한 수령 방식, 판매 중(`PUBLISHED`이고 판매 기간 안, 화면 상태 `ON_SALE`)이고 그 수령 방식을 받는 상품, 티켓 연동 부가 상품이 아님, 옵션이 그 상품 `options`에 맞음(옵션이 있는 상품은 모든 옵션을 고른다), 계정당 한도(이 주문 수량 + 그 계정의 `PAID`·결제 접수한 주문 수량 ≤ `perAccountLimit`)를 본다. 422 type은 ① `merch-order-mixed` ④ `merch-quantity-limit-exceeded` ⑤ `merch-options-invalid` ⑥ `merch-product-unavailable`이고 ②③⑦은 openapi에 적힌 이름이다. 품절은 409 `merch-sold-out`, 같은 계정의 다른 주문이 같은 상품을 예약하는 중이면 409 `merch-order-in-progress`다.
   - 금액은 서버가 계산한다: 항목마다 상품 가격 × 수량, 택배면 주문에 배송비 한 번. 주문 때 가격·수수료율·옵션·상품 이름·유형·스키마 판을 항목에 복사한다(ADR-0101 결정 7).
   - 한정 상품은 상품 ID 오름차순으로 하나씩 `RESERVE`한다. 하나라도 `SOLD_OUT`이면 앞서 잡은 것을 `RELEASE(restore=1)`로 풀고 409다. `PREV`면 그 주문의 상태로 정한 뒤 한 번만 더 `RESERVE`한다. 결제 접수 전 `CREATED`면 조건부 `EXPIRED`(O7과 같은 전이, 사유는 '같은 상품의 새 주문') 뒤 `RELEASE(restore=1)`, 결제를 접수했거나 `PAID`면 `unpaid`의 그 칸만 지우는 Lua(`CLEAR_UNPAID`, 그 주문을 가리킬 때만), `EXPIRED`·`FAILED`면 `RELEASE(restore=1)`이다. 그 주문이 DB에 없으면(같은 계정의 다른 요청이 만드는 중이거나, 넣기 전에 죽은 요청) 409 `merch-order-in-progress`다. 죽은 요청의 칸은 예약이 끝날 때 만료 작업이 지운다(최대 15분 [가정]).
   - 예약이 모두 되면 주문·항목을 한 트랜잭션으로 넣는다(`CREATED`, `stock_reserved_until` = 주문 시각 + 15분 [가정]). 넣기가 실패하면 잡은 예약을 풀고, 풀지 못하고 죽으면 만료 작업이 'DB에 없는 주문'으로 돌린다(결정 7).
5. **결제 시도·접수·승인 명령(추천 적용).**
   - core DB에 `merch_payment_attempt`(결제 시도: 주문·순번·결제사·수단·상태 `READY`·`ACCEPTED`·`SUPERSEDED`·`EXPIRED`·`FAILED`, 주문마다 `READY` 하나·`ACCEPTED` 하나의 부분 유일 인덱스)와 `merch_confirm_job`(승인 명령 작업: 결제 참조·인증 시각·보낸 상태·다음 시각, 끝나면 지움)을 둔다.
   - 결제 시도 시작: 주문이 `CREATED`이고 예약이 끝나지 않았고 접수 전일 때만이다(아니면 409 `order-expired`·`payment-already-accepted`). 주문마다 3회 [가정]까지(넘으면 409 `payment-attempts-exceeded`), 이전 `READY`는 `SUPERSEDED`다. `PrepareCheckout`(`ORDER_KIND_MERCH`, ADR-0299 결정 3)을 부르고 결제사를 시도에 고정한다. 택배(결제대금예치 상점) 주문은 503 `pg-unavailable`이다(ADR-0299 결정 3, BAT-605가 연다). 결제 시도 시작은 예약 시각을 늘리지 않는다.
   - 결제 접수: 주문 행을 `FOR UPDATE`로 잠그고 `CREATED`·예약이 끝나지 않음·`READY` 시도와 결제사·금액(토스)·`paymentId`(포트원) 일치를 본다(만료면 409 `order-expired`이고 결제사를 부르지 않는다). 같은 트랜잭션에서 한정 상품마다 상품 ID 차례로 `product_stock`을 조건부로 깎고(`stock >= quantity`, 0행이면 주문 `FAILED`(O6)와 그 주문 예약 풀기, 409 `merch-sold-out`), 시도를 `ACCEPTED`로, `stock_reserved_until`을 지금 값과 인증 시각(접수 시각) + 10분 가운데 늦은 쪽으로, 승인 명령 작업을 넣는다. 커밋 뒤 `EXTEND`와 `ConfirmPayment`(데드라인 200ms)를 부르고 202다. `ConfirmPayment`가 `UNAVAILABLE`·`DEADLINE_EXCEEDED`면 작업이 다시 보낸다(1초부터 두 배씩 30초 [가정]까지).
   - 승인 기한(인증 + 10분)이 지나도록 `ConfirmPayment`가 한 번도 받아지지 않았으면 결제사가 명령을 받은 적이 없으므로 주문을 `FAILED`(O6 승인 기한 초과)로 끝내고 두 재고를 돌린다.
6. **결과 당기기와 반영(추천 적용).** core-svc 릴레이 리더의 반복이 1초 [가정]마다 다음 시각이 된 승인 명령 작업을 100건 [가정]까지 `FOR UPDATE SKIP LOCKED`로 잡아 `BatchGetPayments`로 묻는다.
   - `APPROVED`(취소 상태 포함): 한 트랜잭션에서 주문 `CREATED → PAID`(O5, 조건부), 항목은 `READY`(I1), 결제 ID·결제사·승인 시각 기록, 작업 지움. 커밋 뒤 `RELEASE(restore=0)`.
   - `FAILED`·거절: 한 트랜잭션에서 주문 `CREATED → FAILED`(O6, 조건부), 한정 상품마다 `product_stock` + 수량, 시도 `FAILED`, 작업 지움. 커밋 뒤 `RELEASE(restore=1)`.
   - 아직(`ACCEPTED`)이면 2초 [가정], `UNKNOWN`이면 30초, 입금 대기면 60초 뒤에 다시 묻는다. 답에 없으면(명령이 기록되지 않음) `ConfirmPayment`를 다시 보낸다. payment-svc가 답하지 못하면 그 묶음을 5초 [가정] 미룬다.
   - 같은 결과를 두 번 받아도 조건부 전이라 한 번만 반영된다.
7. **재고 예약 만료 작업(추천 적용).** core-svc 릴레이 리더의 반복이 1초 [가정]마다 한정 상품(`limited_qty`가 있고 `DRAFT`가 아닌 상품, 목록은 30초 [가정]마다 다시 읽음)의 `resv`에서 점수가 지금 이하인 원소를 상품마다 100개 [가정]까지 읽고, 주문 상태를 한 문장으로 읽어 이렇게 한다.
   - `CREATED`이고 결제 접수 전: 주문 행 잠금 아래 조건부로 `EXPIRED`(O7, 상태 `CREATED`이고 접수 전이고 `stock_reserved_until`이 지났을 때만)로 바꾸고, 바뀐 주문만 그 주문의 모든 한정 상품에 `RELEASE(restore=1)`.
   - `CREATED`이고 결제 접수함: 만료하지 않는다(결제사가 명령을 받았으면 과금될 수 있다). 결과는 결정 6이 정한다. 같은 원소를 바로 다시 읽지 않게 점수를 지금 + 60초 [가정]로 미룬다.
   - `PAID`: `RELEASE(restore=0)`. `EXPIRED`·`FAILED`이거나 DB에 없는 주문: `RELEASE(restore=1)`(반영 도중 죽어 원소가 남은 경우, P-T42 ⑤. 원소가 있을 때만 돌리므로 한 번만 돌아온다).
   - 결제 접수와 만료는 같은 주문 행을 잠그고 조건부로 바꾸므로 하나만 이긴다(P-T42 ③).
8. **조회와 소유 확인(추천 적용).** `GET /v1/shop/orders`(최근 순 커서, `EXPIRED`·`FAILED` 빼기)·`GET /v1/shop/orders/{orderId}`·`GET /v1/shop/orders/{orderId}/payment-status`(최대 25초 [가정], DB를 1초 [가정]마다 다시 읽음)와 결제 시도·접수는 주문의 `account_id`가 세션 계정과 같을 때만 처리하고, 다르거나 없으면 같은 404 `not-found`다. 계정 병합 뒤의 '계정 묶음' 확인은 계정 병합 소비자가 생길 때 더한다.
9. **저장 구조(추천 적용, 서비스 core-svc).**
   - `merch_order`: 상태 값을 `CREATED`·`AWAITING_DEPOSIT`·`PAID`·`EXPIRED`·`FAILED`로 바꾼다(있는 행: `PENDING` → `CREATED`, `CANCELLED`·`REFUNDED` → `PAID`. 취소·환급은 이미 항목 상태에 있다). `account_id`·`fulfillment`·`amount`(결제 금액)·`stock_reserved_until`·`payment_id`·`consent_version`·`recipient_name`·`recipient_phone`·`delivery_address`·`pickup_slot_id`·`escrow`를 더한다. `pg`는 접수 때 정해지므로 NULL 허용, BAT-610 코드에만 있던 `buyer_name`·`buyer_phone`은 NULL 허용(새 주문은 채우지 않는다)으로 바꾼다. 부분 인덱스 `(stock_reserved_until) WHERE status = 'CREATED'`와 `(account_id, created_at)`을 둔다. 정산 기준일 계산은 주문 상태 `PAID`만 보고 취소·환급은 항목 상태로 거른다.
   - `merch_order_item`: `option_snapshot jsonb`를 더한다(ADR-0101 결정 7).
   - 새 표 `product_type`, `merch_payment_attempt`, `merch_confirm_job`(결정 1·5). 역할 권한은 앱 역할 `core_app`만 쓰고 읽으며, 파트너 역할 `core_partner`는 새 표를 읽지 않는다.
10. **넘긴 것.** 택배 주문의 결제(결제대금예치 상점)와 굿즈 가상계좌(O2~O4)는 BAT-605(LCH-030), 구매자 취소·반품 상태 기계도 BAT-605, 인기 MD 대기열(입장 토큰 확인)은 BUILD_ORDER에 단계가 없어 미정, 주문서·결제 화면(SCR-015·SCR-055)은 화면 묶음(갈래 2), `trade.payments` 소비자는 ADR-0299 결정 5의 되돌릴 조건 때다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 같은 상품 결제 전 주문 하나를 상품 슬롯의 `unpaid` 해시로 지킨다(이 결정) | 같은 계정의 두 주문이 겹쳐도 Lua 하나가 한 쪽만 받는다. DB 잠금을 쥔 채 Redis를 부르지 않는다 | 키가 하나 늘고, 만드는 중인 주문과 겹친 요청은 409로 다시 하게 한다 | 고른다 |
| B. DB 권고 잠금(계정마다)으로 줄 세움 | 규칙이 DB 한 곳에 있다 | 잠금을 쥔 채 Redis를 불러야 하고, 연결 풀이 붙잡힌다 | 쓰지 않는다 |
| C. 만료 작업이 DB만 쓸고 Redis 원소는 보지 않음 | 반복이 하나다 | DB에 없는 주문(넣기 전에 죽음)의 예약이 영영 남아 재고가 묶인다 | 쓰지 않는다 |
| D. 결제 접수 뒤에도 기한이 지나면 만료 | 재고가 빨리 돈다 | 결제사가 승인한 뒤 만료하면 과금된 채 상품이 없다 | 쓰지 않는다 |

## 결과

- 한정 재고는 Redis에서 먼저 깎이고 결제 접수 때 PostgreSQL에서 확정된다. 결제하지 않은 주문의 재고는 15분 [가정] 뒤 1초 [가정] 안에 돌아온다. 결제 접수한 주문은 결과가 정해질 때까지 재고를 쥔다.
- 대가: Redis 키 넷, 표 셋, 리더 반복 둘(만료·당기기), 정비 일 하나가 core-svc에 는다. 결과는 당기기로만 받아 사건보다 늦다(ADR-0299 결정 5).

## 되돌릴 조건

- 만료 작업 한 바퀴(한정 상품 수 × Redis 읽기)가 1초 [가정]를 넘는다고 재어지면 상품마다 읽던 것을 예약이 있는 상품만의 색인으로 바꾼다.
- `merch-order-in-progress` 409가 한 계정에서 잦다고 재어지면(화면이 겹쳐 보냄) 화면의 중복 제출 막기를 먼저 본다.
