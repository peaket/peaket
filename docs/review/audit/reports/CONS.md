# CONS — 웨이브 6 독립 감사 (정합·멱등 관점: 결제/정산/지급·주문·환급·PRIORITY·예매 제한·회차 취소·기기 세션·명령)

- 감사자: 구현에 참여하지 않은 독립 감사자 (CONS)
- 범위: `v0.2.0`(6bcea3c7)..`develop`(42697cf7), 커밋 321개
- 작업 위치: `D:\ticketpass-audit-ro2` (HEAD `42697cf7`, 작업 트리 깨끗함)
- 방법: 코드·마이그레이션·계약·시험을 직접 대조(읽기 전용). 기존 리뷰·ledger·CI 초록은 근거로 쓰지 않았다. 전체 시험·빌드는 돌리지 않았고, 아래 발견은 모두 정적 대조 + 저장소 제약/ SQL 확인으로 뒷받침했다(표적 시험은 실행하지 않았다 — 시간 상한 60분, 발견이 모두 "제약·가드 부재" 유형이라 단위 시험으로 재현되지 않음).
- 심각도 기준: charter §심각도. **높음 2, 중간 5, 낮음 5.**

---

## 1. 상태 기계 표 (감사 대상)

범례: ✅ 코드가 전이를 강제, ⚠️ 일부만 강제/우회 가능, ❌ 강제 없음.

### 1.1 결제 원장 `payment.status`

| 출발 | 도착 | 계기 | 코드 강제 |
| --- | --- | --- | --- |
| (없음) | ACCEPTED | ConfirmPayment 접수(주문당 1행, `payment_order_id_key` 유일) | ✅ |
| ACCEPTED | APPROVED / FAILED / AWAITING_DEPOSIT / UNKNOWN / CANCELED(대사) | 승인 실행기 `finish`, `payment` 행 `FOR UPDATE` + 상태 재확인 | ✅ `drizzle-confirm-jobs.ts:290-302` |
| ACCEPTED | (행 삭제) | 원장이 ACCEPTED가 아니면 잡만 지움 | ✅ `:292-295` |
| AWAITING_DEPOSIT | APPROVED / FAILED | 입금 조회·입금 전 취소 | ✅ `:550-558`, `resolve :639-643` |
| UNKNOWN | APPROVED / FAILED / AWAITING_DEPOSIT / CANCELED | 결과 모름 해소 | ✅ |
| APPROVED | PARTIAL_CANCELED / CANCELED | 일반 취소(부분·전액) | ✅ `:602-617` (`status in ('APPROVED','PARTIAL_CANCELED')`) |
| PARTIAL_CANCELED | CANCELED | 추가 취소 | ✅ |
| FAILED | (전이 없음) | 늦은 입금은 `next_query_at` 신호만 | ✅ (원장을 되살리지 않음) |

불법 전이·이중 지출 관점: 승인 실행기의 `finish`는 원장 행 잠금 → 상태 확인 → 사건·원장·Outbox·잡 삭제를 한 트랜잭션에 쓴다. `payment_event.seq = max+1`도 같은 잠금 안이라 중복 사건이 생기지 않는다. **이중 승인·이중 취소는 DB 잠금으로 막힌다.**

### 1.2 주문 `purchase_order.status` (T1~T26)

| 전이 | 출발→도착 | 강제 |
| --- | --- | --- |
| T1 | null→CREATED | ✅ `createOrder`만 |
| T3/T4 | CREATED→AUTHENTICATED→ACCEPTED | ✅ `acceptTransitions` 한 UPDATE(`status = CREATED`) |
| T5/T6 | CREATED/AUTHENTICATED→EXPIRED | ✅ `expiryDecision` + 행 잠금, 활성 결제 시도(READY 40분) 있으면 보류 |
| T9~T17 | RESERVED/UNKNOWN/AWAITING_DEPOSIT→APPROVED/FAILED/… | ✅ 조건부 UPDATE + `payment_event_seq < seq` (ADR-0146) |
| T18/T19 | APPROVED→CONFIRMED/APPROVED | ✅ |
| T21 | CONFIRMED→AWAITING_DEPOSIT | ✅ `DEPOSIT_REVERSED`만 |
| T22~T26 | CONFIRMED/PARTIALLY_REFUNDED→PARTIALLY_REFUNDED/REFUNDED | ✅ `orderTransitionAfterCancel` |

모든 상태 변경 SQL은 `drizzle-orders.ts` 하나에 있고 CI가 강제한다(`test/order-status-sql.test.ts`). `order_event.seq`는 조건부 UPDATE가 돌려준 `event_seq`로만 쓰고, 매일 검사가 `event_seq`·마지막 도착·행 수를 견준다. **주문 상태 기계는 감사 범위에서 가장 견고하다.**

### 1.3 예매 취소 `order_cancellation.status`

REQUESTED → REFUND_PENDING → REFUNDED, VOIDED(CS). `(order_id, ticket_id) where status<>'VOIDED'` 유일 인덱스가 같은 티켓의 두 번째 취소를 막는다(`0014_order_cancellation.sql:26`). ticket-svc가 `ALREADY_CANCELLED`를 돌려줘도 purchase-svc가 이 인덱스로 `CONFLICT`가 되어 **이중 환불은 막힌다**(`drizzle-cancellation.ts:93-98`). ✅

### 1.4 회차 취소 요청 `event_cancellation_request.status`

REQUESTED → JUDGED → (PENDING_APPROVAL·APPROVED는 **도달 불가**) → RUNNING ⇄ PAUSED → REFUND_WINDOW → COMPLETED / REJECTED. `event_id where status in (활성)` 유일 인덱스로 회차당 하나. ⚠️ 도달 불가 상태 2개(§발견 CONS-08).

### 1.5 일괄 환불 항목 `event_refund_item.status`

PENDING → REFUNDED / FAILED / UNKNOWN / NOT_APPLIED. `#run`이 `canceller.cancel`(기존 예매 취소 Saga)을 부르고, 같은 `cancellationId`(=sha256(requestId:ticketId) 결정적 UUID)를 결제사 멱등키로 쓴다. ✅ 멱등키는 결정적. ⚠️ 항목 선점 없음(CONS-11).

### 1.6 운영 명령 `ops_command.state`

DRAFTED/DRY_RUN → PENDING_APPROVAL → APPROVED/REJECTED → DISPATCHED → SUCCEEDED/FAILED → (재시도) DISPATCHED. 승인은 `요청자 ≠ 승인자` + `PENDING_APPROVAL`만. ⚠️ `approval_expires_at`(10분)을 **아무도 검사하지 않고** AUTO_EXPIRED를 **아무도 쓰지 않는다**(CONS-05).

### 1.7 정산서·지급

`settlement_statement`: CALCULATED → NOTIFIED → CONFIRMED → SCHEDULED → PAID (HELD/DISPUTED/CARRIED_OVER/SUPERSEDED). `payout_batch`: PREPARED → PENDING_APPROVAL → APPROVED → SUBMITTED → COMPLETED/PARTIAL_FAILED. `payout`: REQUESTED → IN_PROGRESS → COMPLETED/FAILED/CANCELED.

- 정산서 계산: 조회 후 삽입(§CONS-01), 유일 제약 없음. ⚠️
- 지급 묶음 승인: 2인(요청자≠승인자)·commander·재인증. ✅
- 지급 실행: 건별 결과를 버리고 묶음 상태만 씀(§CONS-02·03). ⚠️
- `PARTIAL_FAILED`, `payout.IN_PROGRESS/COMPLETED/FAILED`는 **코드가 쓰지 않는 죽은 상태**.

### 1.8 PRIORITY `priority_grant`

OFFERED → USED / EXPIRED / WITHDRAWN. `cancelled_ticket_id` 유일(취소표당 1개), `(event_id, seat_id) where OFFERED` 유일(좌석당 1개). 주문 생성이 `active_order_id is null and status='OFFERED' and expires_at > now` 조건부 UPDATE로 권리를 잡고, 승인(APPROVED) 시 USED, 실패·만료·환불 시 `active_order_id` 해제. ✅ **불법 전이·이중 사용 없음.** 좌석이 이미 팔렸으면 `active()` 확인 + 보류 해제·회수.

### 1.9 예매 제한 사본 `q:rst` / `s:rst`

`ver`가 저장 값보다 클 때만 반영(Lua). `st=ACTIVE && (until 없음 || now < until)`이면 403. purchase-svc는 주문 생성 트랜잭션 **앞에서** 읽고, 403이면 그 구매 세션의 홀드를 모두 푼다. ✅ 판 번호 가드 있음.

### 1.10 기기 세션 `session`

활성 → LOGOUT/DEVICE_LIMIT/REFRESH_REUSE/DELETE/MERGED/LOGIN_METHOD_CHANGED. 다른 기기 로그아웃은 재인증(같은 세션·FAN_SENSITIVE) + 계정 잠금 + 소유 확인 + 재인증 jti 1회용. ✅ **IDOR 없음.** 리프레시 회전은 세션 행 `FOR UPDATE`로 직렬화. ⚠️ 재시도 유예의 1회 가드(CONS-07).

---

## 2. 발견

### [높음] CONS-01: 회차·상품 정산서가 동시 요청에서 중복 생성되어 같은 매출이 두 번 지급될 수 있다
- 영역/배치: 결제/정산 (BAT-610 잔여, settlement)
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:92-112`(회차), `:115-147`(상품), `services/payment-svc/src/modules/settlement/adapters/db/drizzle-settlement-store.ts:141-157`(`findEventStatement`)
- 증거:
  - `calculateEvent`는 `findEventStatement(...)`로 **먼저 조회한 뒤** `insertStatement`를 부른다. 두 호출이 겹치면 둘 다 "없음"을 읽고 둘 다 삽입한다.
  - `0015_settlement.sql`에는 `settlement_statement`의 유일 인덱스가 없다(인덱스 3개 모두 비유일: `settlement_statement_partner_idx`, `_event_idx`, `_payout_idx`). `insertStatement`에도 `on conflict` 처리가 없다.
  - 두 정산서는 같은 `payout_date`(= 계산일+5영업일, 같은 날 계산하면 같은 값)와 `CONFIRMED` 상태를 갖게 되고, `createPayoutBatch`의 `listConfirmed(pg, pgStore, payoutDate)`가 **둘 다** 집어 지급 묶음에 넣는다. 같은 결제의 매출이 두 정산서에 중복 계상된다.
  - 일일 불변식 M4(`m4_refund_in_two_statements.sql`)는 `statement_source kind='REFUND'`만 보므로 **환불이 없는 정산서 중복은 잡지 못한다.**
- 왜 문제인가: 파트너에게 같은 매출을 두 번 지급한다(직접 금전 손실). 운영자가 "계산" 버튼을 두 번 누르거나, 응답을 잃고 재시도하거나, 두 파드/두 요청이 겹치면 발생한다. 중복이 지급 전에 발견되지 않으면 되돌릴 방법도 없다(지급 후 회수는 미수금으로만 가능).
- 재현/확인: `grep -n "CREATE UNIQUE INDEX" services/payment-svc/migrations/0015_settlement.sql` → `payout_ref_key`, `payout_batch_statement_seq_key`, `payout_batch_key`뿐. `settlement_statement` 유일 제약 0건.
- 제안 수정: 마이그레이션으로 부분 유일 인덱스를 건다 — 회차: `unique (promoter_id, event_id, pg, pg_store) where kind='EVENT' and status <> 'SUPERSEDED'`; 상품: `unique (promoter_id, pg, pg_store, period_start, period_end) where kind='PRODUCT' and status <> 'SUPERSEDED'`. 그리고 `insertStatement`의 23505를 "이미 계산됨"으로 매핑해 기존 정산서를 돌려준다(현재의 `existing` 반환과 같은 응답). 불변식에 "회차당 비SUPERSEDED 정산서 1개"를 추가.
- 확신도: 높음(제약 부재·경쟁 창은 코드로 확정). 실제 발생 빈도는 중간.

### [높음] CONS-02: 지급 실행이 "승인된 묶음"이 아니라 실행 시점의 확정 정산서를 다시 모아 지급한다
- 영역/배치: 결제/지급 (BAT-610 잔여, payout)
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:317-355`(특히 `:327`), `:225-301`(묶음 만들기)
- 증거:
  - `createPayoutBatch`는 `listConfirmed(...)`로 정산서를 골라 `total_amount`·`statement_count`를 확정하고 `PENDING_APPROVAL`로 저장한다. 그러나 **정산서 행에는 묶음 ID를 쓰지 않는다**(`settlement_statement`에 `batch_id` 칸이 없다). 정산서 상태도 `SCHEDULED`로 바꾸지 않는다.
  - `executeBatch`는 `payouts.length === 0`일 때 `listConfirmed(b.pg, b.pgStore, b.payoutDate)`를 **다시 읽어** 지급 건을 만든다(`:327-346`). 승인 시점의 목록을 쓰지 않는다.
  - 따라서 승인 뒤에 `CONFIRMED`가 된 정산서(다른 이의 해소, 늦은 확정, 중복 계산(CONS-01))가 **승인 없이** 같은 묶음으로 지급된다. `payout_batch.total_amount`는 승인 금액인데 실제 지급 합계는 더 크다.
- 왜 문제인가: 2인 승인이 "금액 X"를 승인했는데 시스템이 "금액 Y>X"를 지급한다. 승인 통제(사람이 본 금액)가 무의미해지고, 회계·정산 대사가 어긋난다.
- 재현/확인: 코드 대조. `executeBatch`가 `b.totalAmount`를 검증하지 않고, `payouts`의 `amount` 합과 `b.totalAmount`를 비교하는 문장도 없다.
- 제안 수정: 묶음 만들 때 정산서에 `payout_batch_id`(또는 `statement.payout_batch_id`)를 같은 트랜잭션에 적고 상태를 `SCHEDULED`로 바꾼다. `executeBatch`는 그 묶음의 정산서만 읽고, 합계가 `b.totalAmount`와 다르면 409로 멈춘다. 승인 뒤 새로 확정된 정산서는 다음 묶음으로 간다.
- 확신도: 높음.

### [중간] CONS-03: 지급 건별 결과를 버려 지급 증거·부분 실패·재시도가 성립하지 않는다
- 영역/배치: 결제/지급 (payout 실행)
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:347-352`, `services/payment-svc/src/modules/settlement/domain/ports.ts:78-92`
- 증거:
  - `PayoutSubmitResult`는 `{ status, pgPayoutIds? }`인데 `executeBatch`는 `result.pgPayoutIds`를 **읽지 않는다**. `payout.pg_payout_id`는 영원히 NULL이다.
  - `payout.status`를 바꾸는 코드가 없다(`REQUESTED`로 삽입한 뒤 갱신 없음). `retryPayout`은 `p.status === 'FAILED'`만 받는데 FAILED를 쓰는 곳이 없다 → **재시도 경로 도달 불가**.
  - `PARTIAL_FAILED`(마이그레이션 CHECK에 있음)를 쓰는 코드 없음. 묶음 결과가 `COMPLETED`면 **모든** 정산서를 `PAID`로 바꾼다(건별 성공 여부와 무관).
  - 일일 불변식 M1(`m1_paid_payout_sum.sql`)은 `statement.status='PAID'`이면 `payout.status='COMPLETED'` 합계가 `payout_amount`와 같아야 한다고 요구한다. 지금 코드로 PAID가 되면 M1은 **항상** 위반이다(그래서 현재 게이트웨이가 COMPLETED를 돌려주지 않아 잠복해 있다).
  - 부수 결함: `PayoutApprovals.approve`는 `executeBatch`가 던지면 승인 업무를 `FAILED`로 남기는데, 그 전에 묶음이 `SUBMITTED`로 커밋됐다면 재시도의 `executeBatch`는 `b.status !== 'APPROVED'`로 409다 → **승인 업무가 영구 FAILED로 고착**(수동 DB 개입 필요).
- 왜 문제인가: 지급이 나갔다는 건별 증거(pg 지급 ID·상태)가 남지 않아 대사·분쟁 대응이 불가능하고, 부분 실패 시 실패 건만 재시도할 수 없다. 실 결제사 어댑터를 붙이는 순간 바로 돈이 걸린다.
- 재현/확인: `grep -n "pgPayoutIds" services/payment-svc/src` → 정의(`ports.ts:85`)만 있고 사용처 0건. `grep -n "PARTIAL_FAILED" .../src` → 타입·CHECK에만 있음.
- 제안 수정: `PayoutSubmitResult`를 건별(`{refPayoutId, status, pgPayoutId, errorCode}`)로 넓히고, 실행 트랜잭션에서 `payout` 행을 갱신 + 묶음 상태를 `COMPLETED`/`PARTIAL_FAILED`로 가른다. `approve` 재시도는 `SUBMITTED`도 받아 `executeBatch`를 "이미 제출됨"으로 멱등 처리한다.
- 확신도: 높음(코드), 영향은 어댑터 활성화 시 높음.

### [중간] CONS-04: 재시도된 옛 판매 중지 명령이 최신 판매 상태를 되돌리고, Redis 사본에는 판 번호 가드가 없다
- 영역/배치: 주문/판매 제어 (BAT-465 R-584, ADR-0123)
- 위치: `services/purchase-svc/src/modules/sale-control/adapters/db/drizzle-sale-control-store.ts:41-61`, `services/purchase-svc/src/modules/sale-control/adapters/redis-sale-control-copies.ts:13-18`, `services/queue-svc/src/modules/sale/adapters/redis-sale-suspension-copies.ts:13-20`
- 증거:
  - DB 조건: `where (version=0 or version > revision) and (command_id is distinct from excluded.command_id or suspended is distinct from excluded.suspended)`. HTTP 경로는 `version=0`이라 판 번호 조건이 항상 참이다. 따라서 **명령 A(SALE_STOP, FAILED) → 명령 B(SALE_RESUME, 성공) → A 재시도**에서 `command_id A ≠ B`, `suspended true ≠ false`이므로 A의 낡은 중지가 다시 적용된다(판 번호 +1, Redis 사본도 `suspended=1`).
  - Redis 사본 쓰기 Lua는 `rev`를 **비교하지 않고** 그대로 덮어쓴다(`HSET ... 'suspended' ... 'rev' ...`). 동시에 두 호출(중지·재개)이 겹치면 늦게 도착한 사본이 최신 원본과 어긋날 수 있다. `SetSaleSuspension`은 `changed=false`일 때도 사본을 쓴다(의도: 앞선 Redis 실패 복구).
- 왜 문제인가: 운영자가 "재개"로 판매를 열었는데 과거 실패 명령의 재시도가 판매를 다시 멈춘다(매출 중단·팬 혼란). 사본이 원본과 어긋나면 `423 sale-paused`가 계속 나가고, 반대로 정지가 풀린 줄 모르고 팔릴 수도 있다.
- 재현/확인: 코드 대조. `set-sale-suspension.ts:24-30`이 `applied.control`(현재 원본)을 쓰는 것은 맞지만, 원본 자체가 낡은 재시도로 뒤집힌다.
- 제안 수정: HTTP 경로도 `command_id`가 다르면 `updated_at`(또는 명령 승인 시각) 비교로 "더 새로운 명령만" 적용한다. Redis 사본 Lua에 `if tonumber(ARGV[rev]) < tonumber(HGET rev or 0) then return 0 end`를 넣어 판 번호가 큰 사본만 쓰게 한다.
- 확신도: 높음.

### [중간] CONS-05: 운영 명령 2인 승인의 10분 기한이 집행되지 않는다(문서·계약과 어긋남)
- 영역/배치: 명령 (BAT-465 GAT-300, ADR-0123·control-tower §4 T7)
- 위치: `services/ops-svc/src/modules/commands/adapters/db/drizzle-command-store.ts:163-182`, `services/ops-svc/src/modules/commands/domain/command.ts:26-40`
- 증거: `#decide`는 `state === 'PENDING_APPROVAL'`과 `requested_by ≠ approverRef`만 본다. `approval_expires_at`을 읽지 않고, `AUTO_EXPIRED`를 쓰는 코드도 없다(`grep AUTO_EXPIRED services/ops-svc/src` → 타입 선언 1건뿐). 생성 시 `now + 10분`을 저장할 뿐이다.
- 왜 문제인가: 문서는 "2인 명령은 10분 기한, 지나면 AUTO_EXPIRED"라고 약속한다. 실제로는 며칠 전 요청도 승인·집행할 수 있어, 승인 시점의 상황(판매 상태·잔액·이벤트 상태)이 바뀐 뒤 낡은 명령이 실행된다. 특히 SALE_STOP/SALE_RESUME·EVENT_CANCEL이 그렇다.
- 제안 수정: `#decide`의 WHERE에 `approval_expires_at is null or approval_expires_at > now`를 넣고 만료 시 `AUTO_EXPIRED`로 전이(감사 사건 포함). 만료 스윕(1분)도 추가.
- 확신도: 높음.

### [중간] CONS-06: 부분 취소 크래시 복구가 결제사 멱등키 수명에 의존하고, 실패하면 원장이 영구히 어긋난다
- 영역/배치: 결제/환급 (GAT-080, HOT-153)
- 위치: `services/payment-svc/src/modules/payment/application/cancel-confirmed-payment.ts:71-88`, `services/payment-svc/src/modules/payment/adapters/pg/toss-shaped.ts:249-252`, `services/payment-svc/src/modules/payment/adapters/pg/portone-gateway.ts:345-354`, `services/payment-svc/src/modules/payment/domain/reconciliation.ts:223-246`
- 증거:
  - 흐름: `beginConfirmedCancel`이 `CONFIRMED_CANCEL_SENT` 사건을 남기고 커밋 → 결제사 취소 → `finishConfirmedCancel`. 중간에 프로세스가 죽으면 재시도는 `BEGUN`(사건은 있고 상태는 APPROVED)이라 **같은 멱등키로 결제사를 다시 부른다**.
  - 결제사가 멱등키를 더는 기억하지 못하면 토스는 `ALREADY_CANCELED_PAYMENT` + 부분 금액이면 `REJECTED`다(전액 `ALL`만 `CANCELLED`). 포트원도 `PAYMENT_ALREADY_CANCELLED`는 `amount==='ALL'`일 때만 CANCELLED. 즉 **부분 취소는 "이미 취소됨"을 성공으로 받아들이지 않는다.**
  - 그러면 purchase-svc는 `REFUND_PENDING`/`REJECTED`로 보고 재시도 상한(5회) 뒤 `refund_failed_at`으로 닫는다. 돈은 이미 나갔는데 원장 `cancelled_amount`는 그대로다.
  - 대사는 이 상태를 `PARTIAL_CANCELED_AT_PG` SEV1로 **탐지만** 하고(`action: 'NONE'`) 원장을 고치지 않는다.
- 왜 문제인가: 부분 환불이 실제로는 성공했는데 원장·주문은 미환불로 남아, 같은 티켓을 다시 취소하면 남은 금액 한도 안에서 **추가 환불**이 가능하다(주문 금액 200, 100 환불 성공·원장 미반영 → 재취소 시 남은 100을 또 환불). CS가 수동으로 고치기 전까지 돈이 두 번 나갈 수 있는 창이 생긴다.
- 재현/확인: 코드 대조. 부분 취소의 "이미 취소됨" 처리 분기가 전액에만 성공을 준다.
- 제안 수정: 취소 전에 결제사 **조회**로 그 `cancellationId`/`paymentRef`의 취소 상태·취소 누적액을 확인하고, 이미 취소됐으면 `cancelledAmount`를 원장에 반영하는 "대조 우선" 경로를 둔다. 최소 수정으로는 대사 `PARTIAL_CANCELED_AT_PG`에 `action: 'REQUERY'`를 주고 단독 조회가 `cancelled_amount`를 맞추게 한다.
- 확신도: 중간(멱등키 수명·결제사 응답은 가정, 코드 경로는 확정).

### [중간] CONS-07: 리프레시 재시도 유예의 "1회" 가드(`refresh_used`)가 구현되지 않았다
- 영역/배치: 기기 세션 (BOT-130, I-T4 ②)
- 위치: `services/identity-svc/src/modules/session/application/refresh-session.ts:65-67`, `services/identity-svc/src/modules/session/adapters/db/drizzle-session-store.ts:559-566`, `services/identity-svc/src/modules/session/domain/session.ts:169-173`
- 증거:
  - `decideRefresh`는 `match==='previous' && now-rotatedAt <= 30초 && !refreshUsed`이면 `retry`다.
  - `refreshUsed`를 **true로 쓰는 코드가 없다**(전 저장소 `grep refreshUsed`: 쓰기는 `refreshUsed: false`뿐 — 회전·생성 시).
  - 재시도 경로 `setRefreshHash`는 `refreshHash`만 새 값으로 바꾸고 `prevRefreshHash`를 지우지 않는다. 따라서 재시도 뒤에도 **같은 바로 앞 토큰이 계속 `previous`**로 남아 30초 동안 몇 번이든 다시 재시도할 수 있다(매번 새 쌍 발급).
  - 문서(identity.md §3 ②)는 "재시도는 `refresh_used`가 거짓일 때"이고 "먼저 준 토큰은 폐기한다"고 약속한다. 구현은 폐기(그 토큰은 `history`로 밀림)는 하지만 1회 가드는 없다.
- 왜 문제인가: 바로 앞 토큰을 훔친 공격자는 30초 동안 반복해서 유효한 액세스·리프레시 쌍을 받을 수 있고, 그 사이 정상 클라이언트의 토큰이 `history`로 밀려 **강제 로그아웃**시킬 수 있다. 창은 30초로 제한되지만 문서가 보장한 "1회"가 아니다.
- 재현/확인: `grep -rn "refreshUsed" services/identity-svc/src` → 대입은 `refreshUsed: false` 2건뿐. 시험 `refresh-cases.ts:70-80`은 "회전으로 밀려난 토큰"만 보고 "바로 앞 토큰의 두 번째 재시도"는 시험하지 않는다(빈칸).
- 제안 수정: 재시도 분기에서 `refreshUsed=true`로 쓰고(같은 트랜잭션), `prevRefreshHash`를 NULL로 만든다. 그리고 "재시도 뒤 같은 앞 토큰 재사용 → REUSE" 시험을 추가.
- 확신도: 중간(코드 확정, 영향은 30초 창·강제 로그아웃으로 제한).

### [낮음] CONS-08: 회차 취소 요청 상태 기계에 도달 불가 상태가 있고, POSTPONE은 요청 경로에서 거절된다
- 위치: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:30`, `:73-84`
- 증거: `request()`는 `kind !== 'CANCEL'`이면 400이다. `PENDING_APPROVAL`·`APPROVED`는 CHECK·타입에 있지만 `approve()`가 JUDGED에서 곧바로 RUNNING으로 간다.
- 왜 문제인가: 계약(openapi EventCancellationRequest)과 실제 전이 집합이 다르고, 연기(POSTPONE)는 운영 명령 경로로만 가능해 두 경로의 기능이 어긋난다. 화면·문서가 상태를 그리면 영원히 나오지 않는 상태가 생긴다.
- 제안 수정: 상태 목록을 실제 전이에 맞추거나(2단계 승인을 넣거나), 요청 경로에서도 POSTPONE을 받는다.
- 확신도: 높음.

### [낮음] CONS-09: EVENT_CANCEL 집행 경로가 둘이고 불변식이 다르다(판정 단계 생략 가능)
- 위치: `services/ops-svc/src/adapters/http-command-executor.ts:41-89` vs `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:64-84`
- 증거: 운영 명령 경로는 `params.fault`를 요청자가 정하고 2인 승인 뒤 바로 `EventRefundService.start`를 부른다. 회차 취소 요청 경로는 `request → judge(귀책·팬 통지) → approve(판정자≠확정자)`를 거친다. 같은 회차에 두 경로가 동시에 열리면 `event_cancellation_request_active_key`(ops)와 `event_refund_request`(purchase)가 서로를 모른다.
- 왜 문제인가: "귀책 판정"이 감사·법적 근거인데 명령 경로는 판정 없이 확정될 수 있다. 두 경로가 같은 회차에 서로 다른 `requestId`로 일괄 환불을 시작하면 purchase-svc가 두 번째를 `CONFLICT`(같은 티켓의 진행 중 취소)로 밀어 대량 FAILED·자동 정지를 유발한다.
- 제안 수정: 명령 경로도 `EventCancellations.request/judge`를 거치게 하거나, 최소한 purchase-svc의 활성 요청 조회로 사전 차단한다.
- 확신도: 중간.

### [낮음] CONS-10: 회차 취소 요청의 판정·확정에 낙관적 판 번호 검사가 없다
- 위치: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:64-84`, `services/ops-svc/src/modules/event-cancellations/adapters/db/drizzle-store.ts`
- 증거: `version: r.version + 1`을 계산해 저장하지만 `where version = ...` 조건이 없다(마지막 쓰기 승). 두 운영자가 동시에 판정하면 둘 다 성공 응답을 받고 한쪽 판정(귀책·팬 통지 문안)이 조용히 사라진다.
- 왜 문제인가: 감사·팬 통지의 근거가 되는 판정이 유실될 수 있다. 돈은 안 깨지지만 기록 무결성이 약하다.
- 제안 수정: `update ... where request_id=$1 and version=$2`로 바꾸고 0행이면 409.
- 확신도: 높음.

### [낮음] CONS-11: 일괄 환불 실행기에 항목 선점이 없어 같은 티켓을 두 실행기가 동시에 처리한다
- 위치: `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:250-330`, `:209-226`
- 증거: `#run`은 `items()`로 목록을 읽어 `PENDING/UNKNOWN`을 큐에 넣고, `updateItem`은 조건 없는 upsert다. 백그라운드 `runDue`와 팬 신청 `apply`, 또는 두 파드의 실행기가 같은 항목을 동시에 집을 수 있다. 결제사 호출은 같은 `cancellationId`라 멱등이지만, `#finishItem`이 두 번 불려 **팬 알림 Outbox가 중복**될 수 있고 진행률·시도 횟수가 경합한다.
- 왜 문제인가: 팬에게 같은 "환불 완료" 알림이 두 번 가고, `attempts`가 실제보다 적게 남아 자동 정지 판정이 흔들린다. 돈은 안 깨진다(멱등키).
- 제안 수정: `updateItem`에 `where status in ('PENDING','UNKNOWN') and (next_attempt_at is null or next_attempt_at <= now)`를 걸어 선점(claim)하고, 알림은 항목 상태 전이에만 붙인다.
- 확신도: 중간.

### [낮음] CONS-12: 문서화된 한계 — 닫힌 주문에 과금된 사건은 자동 환불 경로가 없다
- 위치: `services/purchase-svc/src/modules/booking/domain/payment-result.ts:139-144`, `:209-210`
- 증거: `CHARGED_ON_CLOSED_ORDER`는 `held_event`로 보류되고 SEV1·CS 처리함으로만 이어진다. 코드 주석이 "CS 처리함 건과 환불로 닫는 길은 보상 세 걸음(PRF-173) 무렵"이라고 명시한다.
- 왜 문제인가: 돈은 결제됐는데 주문이 닫혀(FAILED/EXPIRED/COMPENSATED) 자동 환불이 없어, CS가 수동으로 처리할 때까지 팬의 돈이 묶인다. 이미 문서화된 후속이므로 낮음.
- 제안 수정: `held_event` 재처리 도구에 "닫힌 주문 + 과금" 전용 보상(전액 취소) 경로를 붙인다.
- 확신도: 높음(문서화된 한계).

---

## 3. 확인했으나 문제 없음(가드가 실제로 작동)

- **결제 승인 이중 실행**: `payment_confirm_job` 임대(`for update skip locked`), `markSent`가 원장 잠금 뒤 `CONFIRM_SENT` 1건만, `finish`가 잠금 뒤 상태 재확인 → 같은 결제가 두 번 승인되지 않는다.
- **주문 전이·이력**: 조건부 UPDATE + `payment_event_seq` 단조 증가 + `order_event.seq` 연속 + 매일 검사. `drizzle-orders.ts` 밖에서 상태를 바꾸는 SQL은 CI가 막는다.
- **좌석 홀드**: 비트맵·쿼터·만료 인덱스·펜싱 토큰·구역 일련번호를 한 Lua에서 "검사 뒤 쓰기". 세대(seatEpoch) 승격과 `ensureEpoch`가 장애 조치 뒤에도 중복 홀드를 막는다. 만료·해제·연장이 모두 쿼터를 정확히 되돌린다(0 이하면 DEL).
- **PRIORITY**: 취소표당 1개·좌석당 OFFERED 1개 유일 인덱스, 주문 생성의 조건부 `active_order_id` UPDATE, 팔린 좌석 회수. 이중 사용 없음.
- **예매 제한**: `q:rst`/`s:rst` 판 번호 가드(Lua), 주문 생성 403 시 같은 구매 세션 홀드 전부 해제 + 30초 재홀드 차단, 망가진 사본은 fail-closed(500).
- **예매 취소 이중 환불**: `(order_id, ticket_id)` 활성 유일 인덱스 + ticket-svc 멱등 취소표 + 결제사 멱등키. 다른 `Idempotency-Key`로 같은 티켓을 다시 취소해도 `CONFLICT`에서 멈춘다.
- **기기 세션 IDOR**: 재인증(같은 세션·FAN_SENSITIVE) + 계정 잠금 + 그 계정의 활성 세션만 대상 + 재인증 jti 1회용.
- **지급 승인 2인**: 요청자≠승인자, commander만, 재인증 토큰 계정 일치, `approvalId` 멱등.
- **웹훅**: 본문 상태·금액을 믿지 않고 수신 기록 + 단독 조회 신호만. 입금 secret은 해시로만, 서명 없는 위조가 키를 선점하지 못하게 대조 뒤 기록.
- **정산 상계**: 미수금 상계가 같은 파트너·같은 PG의 열린 미수금만, `remaining` 0이면 CLOSED, `receivable_move`로 근거 남김.

---

## 4. 요약

| ID | 심각도 | 한 줄 |
| --- | --- | --- |
| CONS-01 | 높음 | 정산서 중복 생성(유일 제약 없음) → 같은 매출 이중 지급 |
| CONS-02 | 높음 | 지급 실행이 승인된 정산서 집합을 다시 계산 → 승인 금액≠지급 금액 |
| CONS-03 | 중간 | 건별 지급 결과·pg 지급 ID 미반영, 부분 실패·재시도 불가, M1 위반 |
| CONS-04 | 중간 | 옛 판매 중지 명령 재시도가 최신 상태를 되돌림, Redis 사본 판 가드 없음 |
| CONS-05 | 중간 | 운영 명령 10분 승인 기한 미집행(AUTO_EXPIRED 죽은 상태) |
| CONS-06 | 중간 | 부분 취소 크래시 복구가 PG 멱등키 수명에 의존, 실패 시 원장 어긋남 |
| CONS-07 | 중간 | 리프레시 재시도 1회 가드(`refresh_used`) 미구현 |
| CONS-08 | 낮음 | 회차 취소 상태 2개 도달 불가, POSTPONE 요청 경로 거절 |
| CONS-09 | 낮음 | EVENT_CANCEL 두 경로의 불변식 불일치(판정 생략 가능) |
| CONS-10 | 낮음 | 회차 취소 판정·확정에 낙관적 판 번호 없음 |
| CONS-11 | 낮음 | 일괄 환불 항목 선점 없음(팬 알림 중복) |
| CONS-12 | 낮음 | 닫힌 주문 과금의 자동 환불 없음(문서화된 한계) |

- **높음 2, 중간 5, 낮음 5.**
- 배포 전 권고: CONS-01·02는 돈이 직접 걸리므로 지급 기능을 켜기 전에 반드시 고친다(둘 다 마이그레이션+한 트랜잭션 수준의 작은 수정). CONS-03은 지급 어댑터 활성화의 선행 조건. CONS-04·05는 웨이브 안 수정 권고, CONS-06·07은 명시적 후속 또는 웨이브 내 수정.
