# 웨이브 8 갈래 3 웨이브 끝 리뷰: 동시 실행·장애(BAT-415·BAT-420)

- **무엇**: `wave/lane3-w8`의 BAT-415(결제 후 취소 기록·같은 주문 차례 처리·취소 Saga 다듬기·부정 예매 표 취소)와 BAT-420(마감 뒤 환급 전 입장 기록 대조·회차 취소 전용 표 취소·보류 취소 전환·환급 미룸)을 '여럿이 동시에 돌 때'와 '바깥 서비스가 죽었을 때' 관점으로만 본 결과다(2026-11-16).
- **누가**: 리뷰 담당 `l3w8-rev-concurrency`(claude-opus-5-5). 계획·시험·구현에 관여하지 않았고 코드는 고치지 않았다.
- **본 범위**: `git diff 853758eb..b9577fb5`의 제품 코드(payment-svc·purchase-svc·ticket-svc·ops-svc)와 각 계획 파일의 `## 계획` 절. 스냅숏 JSON·생성물은 건너뛰었다. 줄 번호는 `b9577fb5` 기준이다.
- **쉬운 말 풀이**: '결과 모름'은 결제사에 보냈는데 됐는지 안 됐는지 답을 못 받은 상태, '멱등'은 같은 요청을 여러 번 보내도 한 번 보낸 것과 같게 끝나는 성질, '리더'는 여러 파드 가운데 반복 일을 맡은 한 파드, '항목 잡기(임대)'는 한 실행기가 처리 중인 줄에 표시를 남겨 다른 실행기가 같은 줄을 집지 않게 하는 방법이다.

## 1. 지적

### K1 높음 · BAT-420(뿌리는 GAT-090 R-547) · 회차 취소 환급 행을 마감 뒤 환급 실행기도 따로 집어 결제사를 부른다

- **파일:줄**: `services/purchase-svc/src/modules/refund/adapters/db/drizzle-cancellation.ts:238`(`dueRefunds`의 `REFUND_PENDING` 갈래), `.../adapters/db/drizzle-pending-cancellation-conversions.ts:27`(전환 때 `nextRefundAt: null`), `.../application/event-ticket-canceller.ts:66`(회차 취소 행을 `REFUND_PENDING`으로 만듦), `.../application/refund-after-entry.ts:68-125`.
- **틀린 점**: 회차 취소 일괄 환불이 만들거나 전환한 취소 행은 `REFUND_PENDING`이고 다음 재시도 시각(`next_refund_at`)이 비어 있다. 마감 뒤 환급 실행기(`RefundAfterEntry`, 릴레이 리더의 `RefundRetryLoop`)는 `REFUND_PENDING`이고 `next_refund_at`이 비었거나 지난 행을 모두 집으므로, 일괄 환불 실행기가 이미 맡은 행을 한 번 더, 자기 규칙으로 처리한다. `REQUESTED` 갈래에만 '진행 중 일괄 환불이면 집지 않음' 조건이 있고 `REFUND_PENDING` 갈래에는 없다.
- **근거(무슨 일이 생기나)**:
  1. 사람이 일괄 환불을 멈추거나(수동 PAUSED) 자동 정지가 걸려도(결제사 실패율 등) 마감 뒤 환급 실행기는 그 행들을 같은 결제사로 계속 보낸다. 멈춤의 뜻이 없어진다.
  2. 일괄 환불 항목이 결과 모름이면 그 항목의 다음 시각은 `event_refund_item.next_attempt_at`에만 적히고 `order_cancellation.next_refund_at`은 빈 채라, 마감 뒤 환급 실행기가 바로 다음 틱에 같은 취소 ID로 다시 보낸다. 두 실행기의 재시도 횟수·간격이 따로 돈다.
  3. 끝내 실패하면 CS 건이 둘 열린다(`markRefundFailed` + `REFUND_FAILED` 건, 일괄 환불 항목 FAILED + '일괄 환불 실패' 건).
  4. 마감 뒤 환급 실행기는 한 틱에서 같은 주문의 표를 차례로 보낸다. payment-svc는 같은 결제에 10분 안의 진행 중 취소가 있으면 BUSY(보내지 않고 결과 모름)라, 시도 수만 쓰고 BAT-415 몫 E(같은 주문 표를 한 작업자가 차례로)가 지키려던 것을 우회한다. 같은 결제에 진행 중 행이 둘 생기면 3시간 뒤 잔액 대조 조건('다른 진행 중 0')이 둘 다 막혀(K6) CS로만 끝난다.
- **고칠 쪽**: 구현. `dueRefunds`의 `REFUND_PENDING` 갈래에서 진행 중(RUNNING·PAUSED) 회차 취소 요청이 맡은 행(`event_cancellation_request_id`가 그 요청)을 빼거나, 회차 취소 쪽이 행을 만들·전환할 때 `next_refund_at`을 일괄 환불의 재시도 시각과 맞춘다. 부정 예매(FRAUD) 행은 지금처럼 바로 집혀야 하므로(BAT-420 계획 §10) 조건은 회차 취소 요청 ID가 있는 행에만 건다. 시험 담당은 '일괄 환불 PAUSED 동안 그 요청의 REFUND_PENDING 행에 결제사 호출 0'을 단언한다.
- **확인 필요**: 정본(docs/features/transfer-refund.md §5, docs/data.md §5)이 회차 취소 행의 재시도 주인을 일괄 환불 실행기로 정했는지. 요청이 COMPLETED·REJECTED로 끝난 뒤 남은 `REFUND_PENDING` 행을 누가 마무리하는지.

### K2 높음 · BAT-420(뿌리는 BAT-425) · 같은 요청의 일괄 환불을 API 파드와 릴레이 리더가 동시에 돌려 거짓 실패를 낸다

- **파일:줄**: `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:161`(Start), `:261`(Resume), `:282`(Apply), `:295`(CloseWindow), `:304-328`(`runDue`), `:369-471`(`#run`); `.../adapters/db/drizzle-event-refund-store.ts:214-224`(`updateItem`, 상태 조건 없음), `:262`(`dueItems`, 잡기 없음); `.../application/event-ticket-canceller.ts:30-33`; `.../adapters/db/drizzle-pending-cancellation-conversions.ts:13-33`.
- **틀린 점**: Start는 API 파드 안에서 첫 200장을 바로 처리하고, 릴레이 리더의 `runDue`는 RUNNING 요청의 '지금 할' 항목(만들 때 다음 시각 = 지금)을 바로 집는다. 항목 잡기·요청 단위 잠금이 없어 두 실행기가 같은 항목을 겹쳐 처리한다. 같은 주문 차례 처리(몫 E)도 한 프로세스 안에서만 지켜진다. Resume·Apply·CloseWindow도 같다.
- **근거**: 보류 취소 전환 항목을 둘이 함께 처리하면 먼저 온 쪽이 `REQUESTED → REFUND_PENDING`으로 바꾸고, 뒤에 온 쪽은 `convert`가 `NOT_REQUESTED`라 `cancellation-in-progress`로 바로 FAILED가 된다(`IMMEDIATE_FAILURES`). 그러면 실제로는 환급 중인데 CS '일괄 환불 실패' 건과 팬 '환불 실패' 알림(Outbox)이 나가고, `updateItem`이 상태 조건 없이 덮어 REFUNDED를 FAILED로(또는 그 반대로) 바꿔 진행률도 틀린다. `#gapOf`는 전환된 행의 사유가 이미 `EVENT_CANCELLED`라 차액 대상도 못 찾는다. 일반 표는 ticket-svc·결제 멱등 덕에 돈은 한 번이지만, 같은 키를 두 곳에서 동시에 보내 결제사 409(처리 중)를 받고 시도 기록이 두 번 쌓인다.
- **고칠 쪽**: 구현. `#run` 앞뒤로 요청 단위 잠금(예: `pg_try_advisory_lock`으로 요청 ID를 잡고 못 잡으면 이번에는 건너뜀)이나 항목 잡기(잡은 시각·잡은 파드 칸과 `FOR UPDATE SKIP LOCKED`)를 둔다. `updateItem`은 끝난 상태(REFUNDED·FAILED·NOT_APPLIED)를 덮지 않는다. `convert`는 '이미 이 요청 ID로 전환된 행'이면 `CONVERTED`로 답해 멱등하게 한다. 시험 담당은 같은 요청에 `start`와 `runDue`를 장벽으로 겹쳐 '팬 실패 알림 0, CS 건 0, 결제사 호출 1'을 단언한다.
- **확인 필요**: 정본이 'API 파드는 첫 묶음, 나머지는 리더'(relay-app.ts 주석)라고만 하고 겹침을 어떻게 막는지 정했는지.

### K3 중간 · BAT-420(뿌리는 BAT-425) · 확정의 Start 호출이 시간 초과로 끝나기 쉽고, 그러면 ops가 돌고 있는 환불을 멈출 수 없다

- **파일:줄**: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:292-312`(approve의 Start와 실패 때 되돌리기), `:339-343`(pause는 RUNNING·PAUSED만), `services/ops-svc/src/adapters/grpc-event-refunds.ts:93`(호출 한도 30초), `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:158-162`(Start가 첫 200장을 요청 처리 안에서 돈다).
- **틀린 점**: purchase-svc Start는 첫 200장을 동시 8개로 ticket-svc·payment-svc까지 불러 끝낸 뒤에 답한다. 결제사 한 번에 1초만 걸려도 25바퀴라 30초 한도를 넘기 쉽다. ops는 시간 초과를 '실패'로 보고 PENDING_APPROVAL로 되돌리지만, purchase-svc는 이미 요청을 만들고(같은 트랜잭션에서 미룸도 풀고) 환불을 돌리고 있다.
- **근거**: 되돌린 동안 ops의 pause·resume은 상태가 RUNNING·PAUSED가 아니라 409라, 결제사 장애가 보여도 사람이 그 화면에서 일괄 환불을 멈출 수 없다. 누가 다시 확정해야 ops 상태가 맞춰진다. 감사 기록에는 `EVENT_CANCELLATION_APPROVAL_FAILED`가 남아 실제와 다르다.
- **고칠 쪽**: 구현(정본 확인 뒤). Start는 요청·항목만 만들고 바로 답하며 첫 묶음도 리더가 돌리게 하거나(K2도 함께 풀림), ops가 시간 초과·UNAVAILABLE을 '결과 모름'으로 보고 `GetEventRefundJob`으로 확인한 뒤 있으면 RUNNING을 유지한다.
- **확인 필요**: gRPC 'service' 프로필의 실제 기본 한도. 정본(docs/features/transfer-refund.md §5, refund.proto StartEventRefund)이 Start의 응답 시점을 정했는지.

### K4 중간 · BAT-420 · 확정 중 파드가 죽으면 요청이 RUNNING에 갇힌다

- **파일:줄**: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:281-291`(RUNNING 먼저 저장 → 판매 멈춤 HTTP → Start), `:514-520`(`#backToPendingApproval`의 저장 실패를 삼킴).
- **틀린 점**: approve는 바깥 호출 전에 RUNNING을 저장한다(OPS-07). 그 뒤 BAT-420이 판매 멈춤(core·queue 호출)을 Start 앞에 더해 바깥 호출 구간이 길어졌다. 이 구간에서 파드가 끝나거나(배포), 되돌리기 저장이 DB 오류로 실패하면(`.catch(() => false)`) ops 요청은 RUNNING인데 purchase-svc에는 일괄 환불이 없다.
- **근거**: approve는 PENDING_APPROVAL만 받고, pause·resume은 purchase-svc가 NOT_FOUND라 실패한다. 다시 시작할 길이 없고, 걸어 둔 미룸은 72시간 뒤 저절로 풀리며 SEV2가 난다. 회차 취소가 사람 손 없이 멈춘다.
- **고칠 쪽**: 구현. approve가 RUNNING이면서 일괄 환불이 없는 요청도 받아 같은 요청 ID로 판매 멈춤·Start(둘 다 멱등)를 다시 부르게 하거나, 'RUNNING인데 일괄 환불 없음'을 찾아 다시 부르는 정비 일을 둔다. `#backToPendingApproval` 실패는 경고·지표로 남긴다.
- **확인 필요**: 정본에 RUNNING 고착 복구 절차가 있는지.

### K5 중간 · BAT-420 · ticket-svc가 1시간 반쯤 죽으면 회차 전체 항목이 실패로 끝나고 CS 건이 쏟아진다

- **파일:줄**: `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:434`(NOT_SENT를 재시도로), `:500-509`(`#retryOrFail`이 시도 수를 올리고 5회면 FAILED), `:252-256`(resume은 UNKNOWN·PENDING만 다시 봄), `.../domain/event-refund.ts:54-61`(최대 5회, 1분·5분·15분·1시간 간격).
- **틀린 점**: ticket-svc 단계 실패(NOT_SENT)는 결제사 호출이 아니라서 자동 정지 기록에 넣지 않는다(GAT-110 E7). 그런데 시도 수는 소모해, 약 81분 넘게 ticket-svc가 안 되면 모든 항목이 FAILED가 되고 표마다 CS '일괄 환불 실패' 건과 팬 실패 알림이 나간다. 멈춤도 SEV 알림도 없고, resume은 FAILED 항목을 다시 집지 않는다.
- **근거**: 결제사 장애는 실패율로 멈추는데, 그보다 앞 단계인 ticket-svc 장애는 멈추지 않고 '끝난 실패'로 바뀐다. 큰 회차면 수만 건이 CS로 간다.
- **고칠 쪽**: 정본 먼저, 그다음 구현. NOT_SENT는 시도 수를 쓰지 않거나, 연속 NOT_SENT가 기준을 넘으면 요청을 PAUSED(예: ticket 단계 장애)로 두고 SEV2를 내는 규칙을 정한다.
- **확인 필요**: 정본 GAT-110 E7이 NOT_SENT의 시도 수 소모를 정했는지.

### K6 중간 · BAT-415 · payment_cancel의 진행 중 행을 끝낼 길이 부른 쪽의 재시도뿐이다

- **파일:줄**: `services/payment-svc/src/modules/payment/adapters/db/drizzle-confirm-jobs.ts:628-674`(`beginConfirmedCancel`의 다른 진행 중 행·`room`, 645·647줄), `:696-725`(`settleConfirmedCancelByQuery`의 '다른 진행 중 0' 조건), `services/payment-svc/src/modules/payment/application/cancel-confirmed-payment.ts:100-110`.
- **틀린 점**: 진행 중(REQUESTED·CANCEL_PENDING) 행을 CANCELED·FAILED로 바꾸는 것은 같은 취소 ID의 재시도뿐이다(결제사 알림·정리 일이 없다). 부른 쪽이 포기하면(재시도 5회 소진 뒤 CS로 넘김) 그 행은 영영 진행 중이다.
- **근거**: ① 같은 결제의 뒤 취소는 그 금액을 뺀 `room`으로만 보낼 수 있고 전액 취소로 보내지 못한다. ② 3시간 뒤 조회의 잔액 대조는 '다른 진행 중 행 0'일 때만 하므로, 남은 행 하나가 그 결제의 뒤 취소를 모두 UNDECIDABLE(결과 모름)로 만든다. 두 취소가 서로를 막으면 둘 다 결제사에 다시 보내지도, 잔액으로 끝내지도 못한다(K1이 이런 겹침을 늘린다).
- **고칠 쪽**: 정본 먼저. CS가 정리할 때 그 행을 닫는 길(예: 운영 정리 API) 또는 결제사 조회로 오래된 진행 중 행을 끝내는 정비 일을 정한다.
- **확인 필요**: docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액'이 버려진 진행 중 행의 마무리를 정했는지(BAT-415 계획 §1 '막힌 몫'은 CS 정리를 GAT-090에 넘겼다).

### K7 낮음 · BAT-420 · 미룸 기한 지남 SEV2가 로그 한 줄이고, 풀기와 따로라 잃을 수 있다

- **파일:줄**: `services/purchase-svc/src/modules/refund/application/refund-after-entry.ts:133-152`(`#releaseExpiredHolds`), `.../adapters/db/drizzle-event-refund-holds.ts:61-75`(`releaseExpired`).
- **틀린 점**: 풀기(UPDATE)가 먼저 커밋되고 SEV2는 그 뒤 로그다. 그 사이 프로세스가 끝나면 다음 틱은 풀린 줄을 다시 주지 않아 SEV2가 영영 없다. 일괄 환불 자동 정지는 ops 알림 포트(`HttpEventRefundAlert`)로 내는데 이것만 로그다.
- **고칠 쪽**: 구현. 같은 알림 포트로 ops에 내거나, 풀린 수를 지표(카운터)로도 낸다.
- **확인 필요**: 정본이 SEV2를 로그로 내도 된다고 했는지(docs/observability.md).

### K8 낮음 · BAT-420 · 확정 커밋과 다시 확정의 미룸 걸기가 겹치면 풀린 미룸이 다시 걸린다(리뷰 D3의 좁은 틈)

- **파일:줄**: `services/purchase-svc/src/modules/refund/adapters/db/drizzle-event-refund-holds.ts:17-45`(`set`의 `not exists (event_cancellation_request)`), `.../adapters/db/drizzle-event-refund-store.ts:108-150`(`create`가 같은 트랜잭션에서 미룸을 풂).
- **틀린 점**: K3처럼 첫 확정이 시간 초과로 되돌아간 뒤 다시 확정하면, purchase-svc의 `create` 트랜잭션이 아직 커밋 전일 수 있다. 그때 `set`의 부분 질의는 문장 시작 스냅숏이라 요청 행을 못 보고, `create`가 잡은 미룸 줄 잠금을 기다린 뒤 `ON CONFLICT DO UPDATE`로 `released_at`을 다시 비운다.
- **근거**: 진행 중 일괄 환불이 어차피 보류 취소를 막으므로 돈 문제는 없지만, 72시간 뒤 거짓 SEV2가 난다(D3가 막으려던 것).
- **고칠 쪽**: 구현. `set`이 회차 줄을 먼저 `SELECT … FOR UPDATE`로 잡은 뒤 요청 행을 다시 보거나, `create`와 `set`이 같은 회차 단위 잠금을 쓴다.

### K9 낮음 · BAT-420 · 같은 회차 요청 둘이 동시에 오면 둘째가 409·다시 주기 대신 503을 받는다

- **파일:줄**: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:437-445`(replay → 진행 중 확인 → 미룸 걸기), `:467-481`(`#placeHold`).
- **틀린 점**: 같은 Idempotency-Key(같은 요청을 다시 보낸 것으로 알아보는 키)나 다른 키로 두 요청이 거의 같이 오면 둘 다 '다시 줄 응답 없음·진행 중 없음'을 지나고, 둘째의 미룸 걸기가 ALREADY_EXISTS다. 다시 본 진행 중도 첫째가 아직 넣기 전이라 없어 경고 `event-refund-hold-conflict`(거짓)와 503이 된다.
- **고칠 쪽**: 구현. ALREADY_EXISTS면 replay를 다시 보고, 미룸 답에 상대 요청 ID를 실어 409로 답한다.

### K10 낮음 · BAT-420(뿌리는 이전) · 릴레이 멈춤이 gRPC 클라이언트를 반복 일보다 먼저 닫는다

- **파일:줄**: `services/purchase-svc/src/relay-app.ts:399-404`.
- **틀린 점**: `stop()`이 결제·ticket 클라이언트를 닫은 뒤 `relay.stop()`으로 리더 반복을 멈춘다. 도는 중이던 일괄 환불 항목은 NOT_SENT·결과 모름으로 시도 수를 쓰고, BAT-420이 더한 입장 기록 조회는 실패로 건너뛴다(배포마다 생긴다).
- **고칠 쪽**: 구현. `relay.stop()`을 기다린 뒤 클라이언트를 닫는다.

### K11 낮음 · BAT-415 · 팬 취소와 운영자·회차 취소의 표 행 잠금 차례가 다르다

- **파일:줄**: `services/ticket-svc/src/modules/ticket/adapters/db/drizzle-ticket-store.ts:154-164`(`cancel`은 요청 차례로 한 장씩 잠금), `:234-242`(`operatorCancel`)·`:300-307`(`eventCancel`, 표 ID 차례로 한 번에 잠금).
- **틀린 점**: 팬 취소가 표 여러 장을 한 번에 보내면 요청 차례로 잠그므로, 표 ID 차례로 잠그는 운영자 취소(최대 500장)와 서로 기다려 교착(데드락)할 수 있다.
- **고칠 쪽**: 구현(필요하면). `cancel`도 표 ID 차례로 먼저 한 번에 잠근다.
- **확인 필요**: purchase-svc 취소 Saga가 늘 표 한 장만 보내는지. 그렇다면 영향 없다.

## 2. 확인했고 문제없던 것

- payment-svc `payment_cancel`: 잠금 차례가 결제 행 → 취소 행으로 같고, 같은 취소 ID의 겹친 재시도는 결제 행 잠금으로 줄을 서 한 행만 만들며, 반영(`#applyCancelRow`)은 행이 CANCELED가 아닐 때만 한 번 더한다. 결제사 호출 중에는 잠금을 쥐지 않는다.
- 마감 뒤 환급의 보류 취소 집기(`claimDue`)는 미룸·진행 중 일괄 환불 조건을 한 문장 안에서 다시 보고, 전환(`convert`)과는 상태 조건(REQUESTED)으로 한쪽만 이긴다. 둘의 잠금은 주문 행 → 취소 행 하나뿐이라 교착이 없다.
- 미룸 풀기(`releaseExpired`)는 `FOR UPDATE SKIP LOCKED`(남이 잠근 줄은 건너뛰기)와 조건부 갱신이라 여러 파드가 겹쳐도 한 줄은 한 번만 나온다.
- ticket-svc `eventCancel`·`operatorCancel`은 대상 행을 표 ID 차례로 한 번에 잠그고, 잠근 뒤 (취소 ID·표)·(승인·표) 기록을 다시 봐 같은 요청 되풀이에 처음 결과를 준다.
- ops 회차 취소 확정·판정·반려는 판(version) 조건 저장이라 두 사람이 동시에 눌러도 하나만 이긴다. 미룸 저장소가 없으면 CANCEL 요청·판정·확정이 503으로 닫힌다(fail-closed).
- 부정 예매 표 취소는 결제사를 부르지 않고 승인·표에서 정해지는 취소 ID로 취소 행을 하나로 모으며, 결과 저장은 행이 없거나 FAILED일 때만 써 늦은 실패가 앞선 결과를 덮지 않는다.

## 3. 셈

| 묶음 | 높음 | 중간 | 낮음 | 합 |
| --- | --- | --- | --- | --- |
| BAT-415 | 0 | 1(K6) | 1(K11) | 2 |
| BAT-420 | 2(K1·K2) | 3(K3·K4·K5) | 4(K7·K8·K9·K10) | 9 |
