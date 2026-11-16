# 웨이브 8 갈래 3 끝 리뷰 — 정확성(BAT-415·BAT-420)

- 리뷰 담당: `l3w8-rev-correct`(claude-opus-5-5), 2026-11-16. 계획·시험·구현에 관여하지 않았고 코드는 고치지 않았다.
- 본 범위: 가지 `wave/lane3-w8`, `853758eb..b9577fb5`. 파일은 모두 `git show b9577fb5:<경로>`로 읽었다(작업 트리는 보지 않았다). 아래 줄 번호도 그 커밋 기준이다.
- 계획은 `docs/review/plans/BAT-415.md`·`BAT-420.md`의 `## 계획` 절만 읽었다(앞선 리뷰·검증 절은 읽지 않았다). 스냅숏 JSON·생성물은 건너뛰었다.
- 관점: 금액·잔액·공제·차액 계산, 상태 전이(주문·취소·환급·회차 취소 요청·미룸), 경계값(마감 50시간·72시간·9~64자), 오류 응답·문제 제목과 오류 목록, 바뀐 포트·proto 칸을 모든 호출자가 따라왔는지, 마이그레이션이 기존 행에서 실패하지 않는지.

## 요약

| 묶음 | 높음 | 중간 | 낮음 |
| --- | --- | --- | --- |
| BAT-415 | 0 | 0 | 1 (C6) |
| BAT-420 | 0 | 2 (C1, C2) | 4 (C3, C4, C5, C7) |

막는 지적(높음)은 없다. 돈이 두 번 나가는 길은 찾지 못했다: 모든 환급 호출이 같은 결제사 멱등키 `cancel-{취소 ID}`와 payment-svc `payment_cancel` 한 행으로 모이고, `finishConfirmedCancel`·`settleConfirmedCancelByQuery`가 결제 행 잠금 안에서 행마다 한 번만 더한다.

## 지적

### C1 (중간, BAT-420 몫 E·D ↔ GAT-090 환급 실행기) 회차 취소 일괄 환불의 환급 행을 마감 뒤 환급 실행기도 집어 재시도가 둘이 된다

- 파일:줄: `services/purchase-svc/src/modules/refund/application/event-ticket-canceller.ts:81-88`(`#pay`: 결과 모름이면 상태를 쓰지 않고 `REFUND_PENDING`, 업무 거절이면 `refund_failed_at`을 남기지 않고 `FAILED`), `…/adapters/db/drizzle-pending-cancellation-conversions.ts:27`(전환이 `next_refund_at`을 비운다), `…/adapters/db/drizzle-cancellation.ts:238`(`dueRefunds`의 `REFUND_PENDING` 갈래는 회차 취소 요청에 매인 행을 빼지 않는다).
- 틀린 점: 회차 취소 전용 표 취소기가 만들거나 전환한 `order_cancellation` 행은 `REFUND_PENDING`·`next_refund_at` 빔·`refund_failed_at` 빔으로 남는다. 그래서 1분 반복 `RefundAfterEntry`가 다음 틱에 그 행을 집어 같은 취소 ID로 결제사를 따로 부르고, 일괄 환불 실행기도 자기 항목 재시도(다음 시도 시각)로 같은 행을 부른다.
  - 두 쪽이 10분 안에 겹치면 payment-svc는 같은 결제의 다른 진행 중 건이 아니라 같은 건의 재요청이라 BUSY가 아니지만, 같은 주문의 다른 표 건과 겹치면 BUSY(결과 모름)를 준다. 그 결과 모름이 일괄 환불 항목의 시도로 기록되어(`event-refund-service.ts` `#recordAttempt`) 자동 정지 실패율·연속 실패에 섞인다. BAT-415 리뷰 B4와 data §5 '같은 주문의 표 둘을 동시에 취소'가 막으려던 것이다.
  - `RefundAfterEntry`는 자기 `refund_attempts`로 5회를 세고 다 쓰거나 업무 거절이면 `markRefundFailed` + CS '환급 실패' 건을 연다. 일괄 환불 항목도 실패하면 `#finishItem`이 실패 알림을 연다. 한 거절에 CS 건이 둘 생길 수 있고, 일괄 환불이 아직 재시도 중인 건이 CS로 넘어갈 수 있다.
- 근거: `writes.create`는 `next_refund_at`을 넣지 않는다(같은 파일 158·187·203줄만 그 칸을 쓴다). `dueRefunds`의 `REQUESTED` 갈래는 미룸·진행 중 일괄 환불(`eventRefundRunning`)을 빼지만 `REFUND_PENDING` 갈래는 조건이 `next_refund_at`뿐이다. 이전 판(BAT-425)도 예매 취소 Saga가 결과 모름 때 `scheduleRefundRetry`로 1분 뒤 시각을 적어 겹침이 있었지만, 이번 전용 취소기는 아무것도 쓰지 않아 다음 틱에 바로 겹친다.
- 고칠 쪽: 계획(정본 data §5 경합 줄에 '진행 중 회차 취소 요청에 매인 환급 행은 일괄 환불 실행기 하나만 다시 부른다'를 정할지) → 구현(`dueRefunds` `REFUND_PENDING` 갈래에 `event_cancellation_request_id`가 RUNNING·PAUSED·REFUND_WINDOW 요청이면 빼는 조건, 또는 전용 취소기가 결과 모름·거절을 행에 적기) → 시험(전환·전용 취소기 행이 `dueRefunds`에 나오지 않는다, 같은 거절에 CS 건 하나).
- 확인 필요: 일괄 환불이 COMPLETED·REJECTED로 끝난 뒤 남은 `REFUND_PENDING` 행을 누가 이어 가는지(위 조건을 넣으면 그때는 `RefundAfterEntry`가 다시 집어야 한다).

### C2 (중간, BAT-420 몫 D) 확정 때 남는 공제 차액 CS 건을 하나라도 못 열면 나머지도 열지 않고 다시 열지도 않는다

- 파일:줄: `services/purchase-svc/src/modules/refund/application/event-refund-service.ts:160`(처음 만들 때만 부름), `:179-183`(한 `try` 안의 `for`), `:442`(항목 실패 뒤 차액 건 열기는 `try` 밖).
- 틀린 점: `#openDeductionGaps`는 `gaps.list` 결과를 돌며 `gapNotice.open`을 차례로 부르는데, 하나가 던지면(ops-svc 잠깐 멈춤·시간 초과) `catch`로 빠져 남은 행을 모두 건너뛰고 경고 한 줄만 남긴다. 같은 요청 ID로 다시 `start`를 불러도 `existing`에서 바로 돌아가므로(118~121줄) 다시 열 길이 없다. R-T38 ④(OPEN[45] 결정 ②: 남는 차액은 CS가 돌려준다)의 대상 팬이 CS 건 없이 남아 차액을 못 받는다(돈).
  - 442줄은 `#finishItem(… FAILED …)` 뒤에 `gapNotice.open`을 부르는데, 던지면 `processItem`의 `catch`가 이미 끝난 항목에 `#recordAttempt(UNKNOWN)`·`#retryOrFail(UNKNOWN)`을 한다. 끝난 항목이 결과 모름 재시도로 돌아가 자동 정지 셈에 들어갈 수 있다.
- 근거: 계획 §11 몫 D의 '찾기·열기가 실패해도 일괄 환불은 이어 간다(best effort)'는 일괄 환불을 막지 말라는 뜻이고, 차액 건을 잃어도 된다는 규칙은 정본에서 찾지 못했다. ops 쪽 차액 건 사건 키는 SHA-256 UUID로 정해지므로(`domain/case-event-key.ts`, 리뷰 반영 R2) 다시 열어도 한 건으로 모인다.
- 고칠 쪽: 구현(행마다 따로 잡고, 실패한 차액 건은 다음 `runDue` 틱에 다시 열기, 또는 Outbox로 보내기. 442줄은 `try`로 감싸 항목 상태를 바꾸지 않기) → 시험(열기가 두 번째 행에서 한 번 던져도 셋째 행은 열리고, 다음 틱에 둘째가 열린다).
- 확인 필요: `#retryOrFail`이 이미 FAILED인 항목을 UNKNOWN으로 되돌리는지(되돌리면 442줄 몫은 중간 그대로, 아니면 낮음).

### C3 (낮음, BAT-420 몫 Q·W·P) ops 회차 취소 문제의 제목이 오류 목록(openapi `x-peaket-problem-types`)과 다르다

- 파일:줄: `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts`의 이번 범위에 새로 들어간 줄.

| 줄 | 문제 이름 | 코드 제목 | 오류 목록 제목 |
| --- | --- | --- | --- |
| 124 | `invalid-query` | 회차 ID가 올바르지 않습니다 | 목록 조건이 올바르지 않습니다 |
| 130 | `sale-not-suspended` | 판매 중지된 공연의 회차가 아닙니다 | 판매 중지된 공연이 아닙니다 |
| 154 | `event-ended` | 공연이 끝난 회차입니다 | 공연이 끝나 요청할 수 없습니다 |
| 156 | `postponement-date-invalid` | 연기 일시는 지금 공연 시작보다 늦어야 합니다 | 바뀐 공연 시작 시각이 올바르지 않습니다 |
| 253 | `event-refund-unavailable` | 미리보기를 계산하지 못했습니다(판정은 저장됨) | 일괄 환불 실행기를 쓸 수 없습니다 |
| 268 | `preview-required` | 미리보기 없이는 확정할 수 없습니다 | 미리보기를 계산한 뒤 확정할 수 있습니다 |
| 331 | `approver-ineligible` | 판정자는 반려할 수 없습니다 | 판정자는 확정할 수 없습니다 |
| 375 | `reauth-unavailable` | 재인증 검증기를 조립하지 못했습니다(identity JWKS URL 없음) | 재인증 검증기를 쓸 수 없습니다 |

- 틀린 점: `views.ts` `fail`이 도메인 제목을 그대로 Problem `title`로 내보내므로 응답 제목이 계약과 다르다. 124줄은 본문(`eventId`) 검사인데 쿼리 문제 이름을 쓴다(같은 함수 125줄은 `invalid-body`).
- 고칠 쪽: 구현(목록 제목으로 맞추기, 124줄은 `invalid-body`로) → 시험(문제 이름마다 제목이 목록과 같다는 단언 하나). 제목을 바꾸려면 계획이 openapi를 먼저 고친다.

### C4 (낮음, BAT-420 몫 D ↔ BAT-415 리뷰 B2) 첫 팬 취소로 잇는 행은 접수 시각이 둘째 누름 시각이라 차액 대상 판정이 어긋날 수 있다

- 파일:줄: `services/purchase-svc/src/modules/refund/application/cancel-ticket.ts:147`(첫 취소 ID로 이어 쓸 때도 `nowMs: i.nowMs`, 공제는 104~115줄의 첫 키 폐기 시각 견적), `…/adapters/db/drizzle-deduction-gap-cancellations.ts:34`(`c.created_at >= 입장 시작`을 '입장 시작 뒤 접수'로 쓴다).
- 틀린 점: K1이 입장 시작 전에 키만 폐기하고 K2가 입장 시작 뒤에 이으면, 공제는 K1 시각(입장 전 공제율)인데 `created_at`은 K2 시각이라 회차 취소 확정 때 차액 CS 건 대상에 든다. 정본 R-T38 ④의 대상은 입장 시작 뒤 '접수된' 취소다.
- 고칠 쪽: 계획(차액 대상의 '접수 시각'을 첫 키 폐기 시각으로 볼지 정함) → 구현(이어 쓸 때 첫 시각을 남기는 칸, 또는 차액 찾기를 공제 기준 시각으로) → 시험.
- 확인 필요: 정본 transfer-refund §5 '회차 취소 요청 중 보류 취소의 환급 미룸'의 '접수' 정의.

### C5 (낮음, BAT-420 리뷰 D5 ↔ BAT-415 리뷰 B2) 키만 폐기된 팬 취소가 확정된 회차에서는 자동으로 끝나지 않는다

- 파일:줄: `services/purchase-svc/src/modules/refund/application/cancel-ticket.ts:62`(확정된 회차의 팬 취소는 티켓 단계 전에 409 `event-cancelled`), `…/application/event-ticket-canceller.ts:51`(표가 이미 끝났고 자기 취소 행이 없으면 `ticket-already-ended`).
- 틀린 점: 팬 취소 K1이 티켓 단계만 마치고(키 폐기, `order_cancellation` 없음) 멈춘 뒤 회차 취소가 확정되면, 팬이 다시 눌러도 62줄이 막고, 일괄 환불 항목은 ticket-svc가 `ALREADY_ENDED`를 주어 실패한다. `#overlapGapOf`는 USER 취소 행이 없어 차액 건도 열지 않고 일반 실패 알림만 연다. 표는 무효인데 자동 환급이 없고 CS가 손으로 처리해야 한다.
- 근거: B2가 막으려던 '표는 폐기됐는데 환급이 없음'이 회차 취소 확정과 겹친 경우에만 남는다.
- 고칠 쪽: 계획(이 경우의 길을 정함: 전용 취소기가 `CancelTickets` 확인(`replay_only`)으로 첫 팬 취소 ID를 받아 공제 0원으로 마칠지) → 구현 → 시험.

### C6 (낮음, BAT-415 보충 2) 결제사 어댑터의 취소 멱등키 검사가 9자 아래 경계를 따라오지 않았다

- 파일:줄: `services/payment-svc/src/modules/payment/domain/payment-gateway.ts:258` `CANCEL_IDEM_KEY = /^cancel-[A-Za-z0-9_-]{1,64}$/`.
- 틀린 점: 계획 §10 보충 2는 `CANCEL_IDEM_KEY`도 `{9,64}`로 좁힌다고 적었지만 파일이 바뀌지 않았다. 지금은 `confirmed-cancel.ts:6`·`deposit-cancel.ts`의 입력 검사가 8자 이하를 먼저 막아 실제 길은 없다. 다만 포트원·토스 어댑터(`portone-gateway.ts:335`, `toss-shaped.ts:237`)의 마지막 방어선은 포트원 멱등키 16자 미만을 그대로 받는다.
- 고칠 쪽: 구현(`{9,64}`) → 시험(어댑터에 `cancel-abcdefgh` 15자가 오면 TypeError).

### C7 (낮음, BAT-420 몫 E·A) 결제사 환급 뒤 환급 상태 쓰기가 0행이어도 전용 취소기·예매 취소 Saga는 경보를 남기지 않는다

- 파일:줄: `services/purchase-svc/src/modules/refund/application/event-ticket-canceller.ts:84`, `…/application/cancel-ticket.ts:167`·`:200`(`updateStatus`의 참·거짓을 보지 않는다).
- 틀린 점: 이번 범위에서 `updateStatus(REFUNDED)`가 `REFUND_PENDING` 행만 바꾸게 되었다(`drizzle-cancellation.ts` 리뷰 A3). 그사이 CS가 무효(`VOIDED`)로 끝낸 행이면 결제사는 돌려줬는데 0행이다. `RefundAfterEntry`는 다시 읽어 SEV1 `cancellation-refunded-after-void`를 남기지만(리뷰 D1), 두 쓰임새는 그대로 `REFUNDED`(일괄 환불 항목은 환급 완료)로 답한다. 무효 뒤 환급이 경보 없이 묻힌다.
- 고칠 쪽: 구현(같은 다시 읽기·SEV1을 공통 함수로) → 시험(무효 뒤 결제사 CANCELLED에 SEV1 한 줄).

## 확인했지만 지적하지 않은 것

- payment-svc `beginConfirmedCancel`: 차례 CANCELED → DONE, FAILED → REJECTED, 10분 안의 다른 진행 중 건 → BUSY(599,999ms 막음, 600,000ms 통과), 그다음 금액 검사. 금액을 비운 요청은 결제 금액 − 누적 취소액 − 진행 중 다른 건 합, 0 이하면 `NO_BALANCE`, 전액 취소 표시는 진행 중 건 0이고 남은 전부일 때만. 3시간 정각부터 조회(`>=`), `canSettleByBalance`는 잠금 안. 계획 P10·P11·P12와 맞다.
- ticket-svc 첫 팬 취소 칸: `REFUND_NOW`·`REFUND_AFTER_CLOSE`이고 사유 `USER`인 가장 이른 기록만, `EventCancelTickets`가 쓰는 `EVENT_CANCELED`(사유 없음)는 들지 않는다. 사유 목록 일곱이 purchase `CANCELLATION_REASONS`·0009 CHECK와 같다. purchase 어댑터는 칸 셋이 다 맞을 때만 잇는다.
- 내부 토큰: purchase `start.ts:317`·`relay-app.ts:199-200` 둘 다 `GrpcTicketCancellations`에 토큰을 넘기고, ticket-svc 처리기가 `OperatorCancelTickets`·`EventCancelTickets`·`GetEntryRecords`에 호출자 `purchase-svc`를 요구한다.
- 경계값: 마감 뒤 환급 `refund_due_at = 공연 시작 + 50시간`, 집기는 `<=`(정각 포함). 미룸 72시간(`259_200_000`), 걸기 상한 7일, '기한 = 지금'은 지난 것. 운영자 취소 마감 판매 종료 − 2시간 정각부터, 1~500장, 128자.
- 마이그레이션: ops 0013의 `(kind = 'POSTPONE') = (new_starts_at IS NOT NULL)`는 이전 판 `request`가 CANCEL만 받았으므로(853758eb `event-cancellations.ts:45`) 기존 행에서 실패하지 않는다. `requested_via` 기본값으로 promoter CHECK도 통과한다. purchase 0022·0023·0024, payment 0021, ticket 0008·0009는 새 표이거나 널 허용 칸이다.
