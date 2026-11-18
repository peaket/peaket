# ADR-0301: 티켓 연동 부가 상품·수령 방식·미수령 자동 취소의 첫 구현(2026-11-18)

- **상태**: 채택(2026-11-18, 추천 적용. 갈래 5 BAT-600 계획 담당이 LCH-020의 정본 빈칸으로 정했다. 방향은 FR-014·FR-015, POL-016(취소·반품 기준), docs/planning/03 §2.13 I2 '미수령'과 용어 '미수령'(마지막 수령 시간대가 끝날 때까지 받지 않으면 다음 영업일에 취소·전액 환급) 그대로이고, 그 안의 집행 세부를 정한다)
- **관련**: [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md)(굿즈 주문·재고 예약), [ADR-0299](0299-merch-payments-order-kind-nullable-event-id.md)(굿즈 결제), [ADR-0062](0062-open-items-delegated-decisions.md)(수령 방식·취소·반품), [docs/data.md](../data.md) §2 `merch_order`·`merch_order_item`·`pickup_slot`, §5, [docs/api/openapi.yaml](../api/openapi.yaml) `POST·GET /v1/tickets/{ticketId}/addons`·`MerchOrderCreatePickup`, [docs/api/proto/peaket/ticket/v1/ticket.proto](../api/proto/peaket/ticket/v1/ticket.proto) `ListHeldTickets`, [docs/verification.md](../verification.md) V-T35, [docs/features/payment.md](../features/payment.md) §11 P-T57, [docs/review/plans/BAT-600.md](../review/plans/BAT-600.md)
- **관련 ID**: V-T35, P-T57, FR-014, FR-015, POL-016, BUILD_ORDER LCH-020

## 맥락

- 티켓 연동 부가 상품(주차권처럼 그 공연 티켓과 함께 쓰는 상품)은 티켓을 가진 계정만 사고, 결제 뒤 월렛의 그 티켓 아래에 이용권으로 보인다(FR-014, V-T35). core-svc는 티켓을 갖고 있지 않아 ticket-svc에 물어야 하는데, 계약의 `ListHeldTickets`는 아직 서버가 없다(ticket-svc가 `UNIMPLEMENTED`로 답한다).
- 주문 항목을 티켓에 잇는 칸이 docs/data.md에 없다(openapi `listTicketAddons` 설명).
- 현장 수령 주문은 고른 수령 시간대(`pickup_slot`)로 받는다. 표는 ERD에만 있고 마이그레이션이 없다. 미수령 자동 취소는 언제·무엇을 돌려주는지 정해지지 않았다.

## 결정

1. **ticket-svc `ListHeldTickets` 서버(추천 적용).** 계정 ID·회차 ID(둘 다 소문자 UUID, 아니면 `INVALID_ARGUMENT`)로 그 계정이 지금 가진 그 회차의 유효한 티켓(상태 `ISSUED`·`ACTIVE`)을 티켓 ID와 상태로 돌려준다. 읽기만 하고 티켓 키·좌석은 싣지 않는다. 부르는 쪽 데드라인은 300ms [가정]이다. core-svc는 실패(`UNAVAILABLE`·시간 초과)를 503 `dependency-unavailable`로 답하고 주문을 만들지 않는다.
2. **부가 상품 주문(`POST /v1/tickets/{ticketId}/addons`, 추천 적용).** 상품이 티켓 연동이고 판매 중이며 수령 방식에 `WALLET`이 있어야 한다(아니면 422 `merch-product-unavailable`). `ListHeldTickets(세션 계정, 상품의 연결 회차)`에 그 티켓 ID가 있어야 하고, 없으면 404 `not-found`(없는 티켓과 남의 티켓을 가르지 않는다)다. 그 밖의 검사(옵션·계정당 한도·한정 재고 예약·결제 전 주문 하나)와 결제 길은 굿즈 주문과 같다(ADR-0300 결정 4~7). 주문은 수령 방식 `WALLET`, 결제 상점 일반, `event_id`는 연결 회차, 배송비 없음이고, 항목에 새 칸 `linked_ticket_id`(그 티켓 ID)를 적는다.
3. **월렛의 부가 상품 목록(`GET /v1/tickets/{ticketId}/addons`, 추천 적용).** `linked_ticket_id`가 그 티켓이고 주문이 `PAID`인 항목을 모은다. 항목이 있으면 그 회차로 `ListHeldTickets(세션 계정, 회차)`를 불러 세션 계정이 지금 보유자인지 보고, 아니면 404 `not-found`다. 보유자가 주문한 계정이 아니면(양도로 받은 티켓) 양도 가능 상품(`product.transferable`)의 항목만 보인다. 항목이 하나도 없으면 물어볼 회차를 모르므로 보유 확인 없이 빈 목록이다(남의 티켓 ID로 알아낼 것이 없다).
4. **수령 방식별 주문 규칙(추천 적용).**
   - 현장 수령(`PICKUP`): 고른 시간대가 주문 항목 상품 가운데 하나의 시간대이고, 다른 항목 상품에도 같은 회차의 시간대가 있어야 한다. 끝난 시간대(`ends_at` ≤ 지금)이거나, 티켓 소지자 전용 시간대인데 `ListHeldTickets(세션 계정, 시간대 회차)`가 비면 422 `pickup-slot-unavailable`이다. 주문의 `event_id`는 시간대의 회차, 결제 상점은 일반이다.
   - 택배(`DELIVERY`): 배송지와 동의가 있어야 하고(없으면 422 `consent-required`), 동의 문안 판은 환경 값 `PEAKET_MERCH_CONSENT_VERSION`과 같아야 한다(다르면 422 `consent-version-outdated`). 수령인·주소·문안 판을 주문에 적고, 결제 상점은 결제대금예치다(결제 시작은 BAT-605, ADR-0299 결정 3). BAT-605 전까지는 이 검사를 마친 뒤 주문 만들기를 503 `pg-unavailable`로 답한다(ADR-0300 결정 4, 추천 적용, 2026-11-19, BAT-600 리뷰 반영).
   - 수령 시간대 표 `pickup_slot`(docs/data.md ERD)을 이 묶음의 마이그레이션으로 만든다. 파트너가 시간대를 만드는 API는 계약에 없어 이 묶음은 만들지 않는다(넘긴 것).
5. **미수령 자동 취소(추천 적용).**
   - core-svc 정비 일 `merch-unclaimed-cancel`이 매일 10:00 KST [가정]에 돈다. 은행 영업일(주말을 건너뛴다. 공휴일 달력은 정산과 같이 후속, docs/features/settlement.md §5.1)에만 일한다.
   - 대상은 `PAID`인 현장 수령 주문의 `READY` 항목이다. 그 상품·그 회차의 마지막 시간대가 끝난 날(KST 날짜) D에 대해, 오늘이 D 다음 영업일이거나 그 뒤면 취소한다(하루를 건너뛰어도 다음 실행이 잡는다).
   - 주문마다 한 트랜잭션에서 그 항목들을 조건부로 `READY → CANCELLED`(I2, 새 칸 `cancel_reason` = `UNCLAIMED`)로 바꾸고 환급 행 `merch_refund`(ID가 결제 취소 ID, 금액 = 취소한 항목의 단가 × 수량 합, 상태 `REQUESTED`)를 넣는다. 커밋 뒤 `CancelPayment`(그 금액, 사유 `UNCLAIMED`)를 부른다. `CANCELLED`면 항목을 `REFUNDED`(I16)로, 환급 금액을 항목에 적고 환급 행을 끝낸다. `CANCEL_PENDING`·`UNKNOWN`·호출 실패면 리더 반복이 10분 [가정]마다 같은 취소 ID로 다시 부르고(결제사 멱등키 `cancel-{취소 ID}`), 3일 [가정] 넘게 끝나지 않으면 SEV2 경고 한 줄이다(3일 정각은 아직 아니고, 넘긴 뒤 처음 실행에서 한 번만 낸다, 추천 적용, 2026-11-19, BAT-600 계획). `REJECTED`면 SEV2 경고 한 줄(`kind` merch-refund-rejected, 주문 ID만)을 남기고 환급 행을 그대로 둔다. '그대로'는 행을 지우거나 `CANCELLED`로 끝내지 않고 금액을 남기며 다시 부르지 않는다는 뜻이고, 행 상태는 `REJECTED`로 적는다(docs/data.md `merch_refund` 상태 값, 추천 적용, 2026-11-19, BAT-600 계획).
   - 재고는 돌리지 않는다(공연이 끝난 뒤라 다시 팔 일이 없다).
   - 같은 항목에 교환권 확인(I4 `READY → PICKED_UP`)이 같은 때 오면 둘 다 `READY`일 때만 바꾸는 조건부 갱신이라 하나만 이긴다.
6. **넘긴 것.** 부가 상품의 구매자 취소(연결 회차 입장 시작 전 전액 환급, 뒤에는 거절, V-T35 ③)와 연결 티켓 취소에 따른 취소는 BAT-605(LCH-030, 취소·반품 상태 기계), 파트너가 수령 시간대를 만드는 API와 화면은 BUILD_ORDER에 단계가 없어 미정, 월렛 화면의 이용권 표시는 화면 묶음(갈래 2)이다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 티켓 보유를 ticket-svc에 그때그때 묻는다(이 결정) | 양도·취소가 바로 반영된다. 논리 DB 사이 조인이 없다 | ticket-svc가 멈추면 부가 상품 주문이 503이다 | 고른다 |
| B. core-svc가 티켓 사건으로 보유 사본을 둔다 | ticket-svc가 멈춰도 산다 | 사본 지연 동안 양도한 티켓으로 살 수 있다. 소비자·표가 는다 | 쓰지 않는다 |
| C. 미수령을 시간대가 끝난 즉시 취소 | 빠르다 | 정본(다음 영업일)과 다르고, 마감 직전 수령 기록이 늦게 들어오는 경우를 끊는다 | 쓰지 않는다 |

## 결과

- 부가 상품은 지금 보유자만 사고 보며, 미수령 현장 수령 상품은 다음 영업일에 전액 환급된다.
- 대가: ticket-svc에 읽기 RPC 하나, core-svc에 칸 둘(`linked_ticket_id`·`cancel_reason`)과 표 둘(`pickup_slot`·`merch_refund`), 정비 일 하나와 리더 반복 하나가 는다.

## 되돌릴 조건

- `ListHeldTickets` 실패로 부가 상품 주문 503이 주문의 1% [가정]를 넘으면 결정 B(보유 사본)를 다시 본다.
- 공휴일에 환급 요청이 나가 민원이 생기면 공휴일 달력을 먼저 넣는다.
