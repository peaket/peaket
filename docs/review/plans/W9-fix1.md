# W9-fix1 계획·기록(GAT-110, 환급 실행기 후속: 잡기 기한·자동 정지 합치기·FAILED 팬 알림)

- 묶음: W9-fix1, 갈래 3. 등급 A(돈: 결제사 환불 호출과 자동 정지). 단계 GAT-110(wbs 5.3.3 ①)의 뒤처리다. `docs/lanes/lane3.md` '## 구간 끝 정리 목록'의 세 줄(BAT-420 다시 보기 2 N3·N8, 다시 보기 3 P3와 같은 뜻인 계획 보충 5의 `#retryOrFail` 줄)을 고친다. 소유자 결정(2026-11-17): 정리 목록 가운데 돈·권한·개인정보 작은 고침부터.
- 바탕: 작업 폴더 `D:/ticketpass-w9-fix1`, 가지 `feature/w9-fix1`, 출발점 `origin/develop` `9199a3de`. 앞 묶음 기록은 [BAT-420](BAT-420.md) §11 보충 4·5, '## 리뷰' 다시 보기 2·3, '## 검증' 검증 2다.
- 재현 시험 먼저 묶음이다. 시험 담당이 지금 코드에서 실패하는 재현 시험을 먼저 쓰고, 구현이 뒤따른다. 이 계획 커밋에는 `Batch-Order`를 달지 않는다.
- 이 파일은 역할마다 자기 절만 쓴다: 계획(아래), 실패 확인(시험), 시험 이의(구현), 리뷰, 검증, 담당 표(감독). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.

## 계획

계획 담당 `w9f1-plan`(claude-opus-5-5), 2026-11-17. 시험·제품 코드는 쓰지 않았다. 정본은 이 커밋에 먼저 썼다('추천 적용 2026-11-17, W9-fix1 …'): transfer-refund §5 '잡기 표시' 아래 '잡기 늘리기'(N3), '수동 일시정지' 다음 새 블록 '멈춤 표시는 합쳐 쓴다'(N8), '주인'의 팬 실패 알림 문장(P3), data(`event_refund_item.claimed_until` 설명, §5 K2 줄 끝과 새 줄 하나), ASVS transfer-refund v5.0.0-15.2.2. guidelines §8.1은 바꿀 것이 없다(셋 다 외부 HTTP 호출의 실패 등급 문제가 아니다). 방향을 바꾸는 결정은 없다. N3은 §5 '잡기 표시'가 그린 '기한이 지나면(파드가 죽음)'만 다시 잡히게 하는 방법이고, N8은 §5 '자동으로 다시 시작하지 않는다'를 겹친 쓰기에서도 지키며, P3은 §5 GAT-130 잔여의 '업무 거절이면 FAILED로 끝내 … 팬에게도 `REFUND_FAILED`'를 그 밖 실패 길에도 지킨다.

- 쉬운 말: '잡기'는 한 주문을 한 작업자가 맡았다는 표시와 그 기한, '늘리기'는 일하는 도중 그 기한을 뒤로 미는 것, '멈춤 합치기'는 진행률을 쓸 때 남이 적은 멈춤을 지우지 않고 내 것만 더하는 것이다.
- 마이그레이션: 필요 없다. 칸(`claim_token`·`claimed_until`, `progress` JSONB)은 그대로 쓴다.

### 1. 지적별 정한 동작

| 지적 | 정한 동작 | 정본 근거 | 고르지 않은 안과 까닭 |
| --- | --- | --- | --- |
| N3 | ① 잡은 작업자는 표를 결제사로 보내기 직전(`processItem`의 `canceller.cancel` 앞, 자동 정지 판정 뒤)에 남은 기한 = 그 작업자가 아는 `claimed_until` − 지금을 본다. 40,000ms [가정] 미만이면 늘린다(40,000ms 정각은 늘리지 않는다). ② 늘리기는 한 문장: 같은 요청·같은 잡기 값·`claimed_until > 지금`·PENDING·UNKNOWN인 행에 `claimed_until = 지금 + 60,000ms`. ③ 0행이면 그 표를 보내지 않고 그 주문의 나머지도 이번 실행에서 부르지 않는다(경고 `event-refund-item-claim-lost`, 시도 기록 없음, 실행 끝에 풀기는 그대로). ④ 늘리기가 던지면 그 표를 보내지 않고 오류를 올린다(다른 쓰기 실패와 같다). ⑤ 표 한도 30,000ms를 상수로 빼고 두 운영 조립의 `deadlineMs`가 쓴다. 잡기 60,000 > 기준 40,000 > 표 한도 30,000 | transfer-refund §5 '잡기 표시'·'잡기 늘리기'(이 커밋), data `claimed_until` | 남은 기한이 짧으면 그 주문을 남기고 멈추는 안은 표 넷 이상 주문이 여러 틱에 걸쳐 늦어진다. 따로 도는 타이머(심장박동)는 멈춘 호출이 잡기를 끝없이 붙든다. 표마다 늘 늘리는 안은 표 하나 주문(가장 흔함)에도 쓰기가 하나씩 는다. 기한 지난 잡기를 같은 값으로 되살리는 안은 다시 잡기와 경합을 따로 따져야 해 고르지 않았다 |
| N8 | ① 진행률의 결제사 멈춤은 요청 행을 `FOR NO KEY UPDATE`로 잠근 한 트랜잭션에서 지금 DB 값에 더하고 빼서만 쓴다(새 저장소 메서드 `updateLocked`). ② 실행 끝(`#run` 601줄): 그 실행의 `newlyPaused`만 더하고 빼지 않는다. 잠근 값이 RUNNING·REFUND_WINDOW면 상태는 지금 규칙(`statusAfterRun`을 합친 멈춤으로, 끝나지 않은 주문 규칙 그대로), PAUSED면 상태는 그대로 두고 멈춤만 더한다, COMPLETED·REJECTED면 쓰지 않는다. ③ 수동 멈춤(307줄): `MANUAL`을 더한다(결제사를 안 주면 잠근 값의 모든 결제사 몫). ④ 재개(325줄): 그 결제사만, 한꺼번에면 재개가 처음 읽은 멈춤만 뺀다. 상태는 지금처럼 RUNNING·REFUND_WINDOW이고 그 실행이 끝에서 다시 정한다. ⑤ 창 닫기(433줄): 잠근 값의 멈춤을 쓰고, 잠근 값이 PAUSED면 상태를 둔다. ⑥ 합치기 규칙: 빼기 먼저, 그다음 더하기. 이미 멈춘 결제사는 DB 사유를 두고 `MANUAL`만 사유를 바꾼다. ⑦ 경보(`alert.raise`)는 지금처럼 그 실행의 `newlyPaused`마다 쓰기 뒤에 | transfer-refund §5 '스스로 멈춤'·'멈춤 표시는 합쳐 쓴다'(이 커밋), data §5 새 줄 | 진행률을 판 번호로 조건부 갱신하고 지면 다시 읽는 안은 같은 결과에 다시 시도 고리가 는다. 결제사 몫 표(`event_refund_pg_part`)로 옮기는 안은 마이그레이션과 읽기 길이 모두 바뀌어 작은 고침을 넘는다. 늦게 끝난 실행이 자기 목록 전부를 더하는 안은 사람이 푼 멈춤을 되살린다 |
| P3 | `#retryOrFail`의 `status === 'FAILED'` 갈래(626~646줄)는 시도 상한과 같이 `#finishItem(request, item, 'FAILED', error, target, { attempts, claimToken })`으로 끝낸다. 그래서 항목 FAILED·`next_attempt_at` 빔·행 실패 표시·`failure_case_at`·팬 `REFUND_FAILED` Outbox 하나가 한 트랜잭션이고, 쓰기가 0행이면 아무것도 없다(LOST). 시도 기록(FAILURE)은 지금처럼 쓰기 뒤 | transfer-refund §5 GAT-130 잔여·'팬 알림'·'주인'(이 커밋의 팬 실패 알림 문장) | 그 갈래에 Outbox만 따로 싣는 안은 같은 끝내기 길이 둘로 남아 다음 고침에서 또 어긋난다 |

- 범위 밖으로 본 것(감독 정리 목록 후보): 지금 코드는 결제사 몫 하나가 자동 정지하면 요청 전체를 PAUSED로 둬(`statusAfterRun`, 시험 `event-refund-gat130` R-T9) 다른 결제사 몫도 멈춘다. 정본 §5 '다른 결제사 몫은 계속한다'와 data `event_cancellation_request.status`('PAUSED는 결제사 몫이 모두 멈췄거나 작업 전체를 멈춘 때')와 어긋난다. 멈추는 쪽이라 돈은 안전하고 상태 규칙을 바꾸면 기존 시험·ops 화면이 함께 바뀌므로 이 묶음은 상태 규칙을 바꾸지 않는다. N8의 합치기는 어느 상태 규칙에도 그대로 쓴다.

### 2. 손댈 파일·인터페이스

모두 `services/purchase-svc/src/modules/refund/` 아래(시작 파일 둘만 `src/`).

| 지적 | 제품 코드(구현 담당) | 인터페이스 |
| --- | --- | --- |
| N3 | `domain/event-refund-ports.ts`, `adapters/db/drizzle-event-refund-claims.ts`(`claimOrders` 반환·새 `extend`), `application/event-refund-service.ts`(작업자가 잡기 기한을 들고 `processItem`이 보내기 전에 늘림), `src/start.ts:406`·`src/relay-app.ts:291`(상수 사용) | `export const EVENT_REFUND_TICKET_DEADLINE_MS = 30_000`(표 한도 30초 [가정]), `export const EVENT_REFUND_CLAIM_EXTEND_BELOW_MS = 40_000`(40초 [가정]). `claimOrders`의 반환에 `claimedUntilMs: number`(= nowMs + `EVENT_REFUND_CLAIM_MS`). `EventRefundClaims.extend(requestId: string, claimToken: string, nowMs: number): Promise<number \| undefined>`(늘린 새 기한, 0행이면 undefined) |
| N8 | `domain/event-refund.ts`(합치기 함수), `domain/event-refund-ports.ts`, `adapters/db/drizzle-event-refund-store.ts`·`adapters/memory-event-refund-store.ts`(`updateLocked`), `application/event-refund-service.ts`(`pause`·`resume`·`#closeWindowNow`·`#run` 끝의 네 쓰기) | `export function mergePauses(current: readonly { pg: RefundPgProvider; reason: RefundPauseReason }[], delta: { readonly add?: readonly { pg: RefundPgProvider; reason: RefundPauseReason }[]; readonly lift?: readonly RefundPgProvider[] }): { pg: RefundPgProvider; reason: RefundPauseReason }[]`. `EventRefundStore.updateLocked(requestId: string, next: (current: EventCancellationRequest) => EventCancellationRequest \| undefined): Promise<EventCancellationRequest \| undefined>`(요청 행을 `FOR NO KEY UPDATE`로 잠근 트랜잭션에서 지금 행을 읽어 동기 함수 `next`를 부르고 돌려준 값을 쓴다. undefined면 쓰지 않는다. 행이 없으면 undefined. 쓴 값을 돌려준다). 서비스는 진행률에 `update`·`updateActive`를 더 부르지 않는다(지울지는 구현이 정한다) |
| P3 | `application/event-refund-service.ts`(`#retryOrFail`) | 바뀌는 인터페이스 없음 |

- 시험 담당이 고칠 기존 시험 대역: `test/event-refund-wave-review.test.ts` 71줄의 `EventRefundClaims` 대역(`claimedUntilMs`·`extend`가 생긴다). 그 밖의 시험은 `update`·`updateActive`를 직접 부르지 않는다(`grep` 확인).

### 3. 재현 시험(시험 담당이 먼저 쓴다)

새 단위 파일은 `test/event-refund-claim-pause.test.ts`로 한다. 시험 이름은 범위 안 ID `GAT-110 N3`·`GAT-110 N8`·`GAT-110 P3`로 시작한다. 단언 값은 정본 값(60,000·40,000·30,000ms, 사유 이름)을 적고 코드 상수를 가져오지 않는다. '재현'은 지금 코드(`9199a3de`)에서 실패해야 하는 시험이다.

| 시험 | 종류·파일 | 단언 | 재현 |
| --- | --- | --- | --- |
| `GAT-110 N3 표 셋이 각 25초 걸리는 주문은 보내기 전에 잡기를 늘려, 셋째 표를 보내는 도중 다른 실행이 그 주문을 다시 잡지 않는다` | 단위·차례(가짜 시계, 메모리 저장소, `claimed_until > 지금`을 지키는 주문 단위 잡기 대역, 부를 때마다 시계를 25,000ms 미는 취소기 대역. 셋째 표 호출 안에서 둘째 서비스의 runDue를 한 번 돌린다) | 둘째 실행의 잡기 빈 목록·취소기 호출 0, 표마다 취소기 호출 1, `extend` 호출 2(잡은 때 + 25,000·+ 50,000ms), 시도 기록 SUCCESS 3·UNKNOWN 0 | 예(지금은 잡은 때 + 75,000ms에 기한 + 60,000ms가 지나 셋째 표 호출 2) |
| `GAT-110 N3 실제 DB에서 API 파드의 느린 주문 처리와 리더 runDue가 겹쳐도 표마다 결제사 호출·시도 기록이 하나이고 결과 모름이 없다` | 통합·동시 `test-int/event-cancel-r-t24.int.test.ts`(K2 묶음 옆, 실제 `DrizzleEventRefundClaims`, 두 서비스가 가짜 `nowMs` 하나를 함께 씀, 막대로 셋째 표 호출 중에 runDue를 `Promise.all`로 띄움) | 취소 ID마다 결제사(대역) 호출 1, `event_refund_attempt` 표마다 1행 모두 SUCCESS, 셋째 표 보내기 전 그 주문 행의 `claimed_until` = 잡은 때 + 110,000ms | 예 |
| `GAT-110 N3 늘리기 기준은 남은 기한 40,000ms 미만이다` | 단위·차례 | 첫 표가 20,001ms 걸리면(남은 39,999ms) 둘째 표 앞에 `extend` 1, 20,000ms면(남은 40,000ms) 0 | 예(1 쪽) |
| `GAT-110 N3 늘리기가 0행이면 그 표를 보내지 않고 그 주문의 나머지도 부르지 않는다` | 단위·차례(대역 `extend`가 undefined) | 둘째·셋째 표 취소기 호출 0, 시도 기록 0, 경고 `event-refund-item-claim-lost` 1, 두 항목 PENDING 그대로, `release` 1. 기한 뒤 다음 runDue가 두 표를 한 번씩 부른다 | 예(지금은 `extend`를 안 불러 보낸다) |
| `GAT-110 N3 잡기 늘리기는 잡기 값이 같고 기한 안일 때만 처리할 항목의 기한을 지금 + 60초로 쓴다` | 통합·차례 `test-int/event-refund.int.test.ts`(`DrizzleEventRefundClaims` 직접) | 잡은 때 0ms: 59,999ms에 늘리면 새 기한 119,999ms이고 PENDING·UNKNOWN 행만 바뀜(REFUNDED 행 그대로), 60,000ms(정각)·다른 잡기 값·풀린 잡기면 undefined이고 행 그대로. 늘린 뒤 다른 잡기는 119,998ms에 빈 목록 | 예(메서드 없음) |
| `GAT-110 N3 잡기 60초 > 늘리기 기준 40초 > 표 한도 30초이고 두 운영 조립의 deadlineMs는 지금 + 30초다` | 단위('운영 시작 검사' 묶음에 한 줄) | 세 상수 값과 차례, `start.ts`·`relay-app.ts` 조립의 `deadlineMs() − nowMs()` = 30,000 | 예(상수 없음) |
| `GAT-110 N8 겹친 두 실행이 서로 다른 결제사를 자동 정지하면 둘 다 남고, TOSS만 재개해도 PORTONE으로는 환불이 나가지 않는다` | 단위·차례(메모리 저장소·주문 단위 잡기 대역 하나에 서비스 둘 A·B. 주문 둘: O1 PORTONE, O2 TOSS, 서킷은 두 결제사 모두 열림. A가 O1을 잡아 PORTONE 정지를 판정한 뒤 다음 잡기 호출에서 막대로 멈춘 동안 B가 O2를 잡아 TOSS 정지로 끝까지 돌아 PAUSED{TOSS}를 쓴다. 막대를 풀어 A가 끝 쓰기를 한다) | 저장된 진행률 TOSS·PORTONE 둘 다 PAUSED(`AUTO_CIRCUIT_OPEN`), 상태 PAUSED, 결제사 호출 0. 서킷을 닫고 TOSS만 재개: O1(PORTONE) 취소기 호출 0, PORTONE PAUSED 그대로, O2는 한 번 | 예(지금은 A의 `updateActive`가 0행이라 PORTONE이 사라지고, 재개 뒤 O1이 불린다) |
| `GAT-110 N8 재개 전에 시작한 실행이 늦게 끝나도 사람이 푼 멈춤을 되살리지 않고, 그 실행이 새로 판정한 자동 정지만 더한다` | 단위·차례(PAUSED{TOSS 자동, PORTONE 수동} → PORTONE 재개의 실행 A가 막대에서 멈춘 동안 TOSS 재개 → A를 푼다. 대조: A가 도중 SIMULATOR 서킷을 판정) | A가 끝난 뒤 TOSS 멈춤 없음. 대조에서는 SIMULATOR만 PAUSED | 예(지금은 A가 처음 본 TOSS로 PAUSED{TOSS}를 다시 쓴다) |
| `GAT-110 N8 한꺼번에 재개는 재개가 읽은 멈춤만 빼고, 읽은 뒤 생긴 자동 정지는 남긴다` | 단위·차례(저장소 대역이 재개의 첫 읽기 뒤·쓰기 전에 다른 실행의 PORTONE 자동 정지 쓰기를 끼운다) | TOSS 풀림, PORTONE PAUSED, 재개의 실행에서 PORTONE 취소기 호출 0 | 예 |
| `GAT-110 N8 신청 창 닫기·수동 멈춤은 그사이 적힌 자동 정지를 지우지 않는다` | 단위·차례(연기 요청. runDue가 닫을 창을 읽은 뒤·쓰기 전에 PAUSED{TOSS} 쓰기를 끼움 / PORTONE 수동 멈춤의 읽기 뒤에 TOSS 자동 정지를 끼움) | 창 닫기 뒤 상태 PAUSED·TOSS PAUSED, 미신청 표 NOT_APPLIED. 수동 멈춤 뒤 TOSS `AUTO_…`·PORTONE `MANUAL` 둘 다 | 예 |
| `GAT-110 N8 멈춤 합치기: 빼기 먼저·더하기 다음, 이미 멈춘 결제사는 DB 사유를 두고 MANUAL만 사유를 바꾼다` | 단위(`mergePauses` 표) | 자동 + 자동은 처음 사유, 자동 + MANUAL은 MANUAL, MANUAL + 자동은 MANUAL, lift 밖 결제사는 남음, lift와 add가 같은 결제사면 add가 남음 | 예(함수 없음) |
| `GAT-110 N8 실제 DB에서 두 끝 쓰기가 같은 순간에 와도 두 자동 정지가 모두 남고, 다른 연결이 그 행을 잡은 동안 updateLocked는 기다린다` | 통합·동시 `test-int/event-refund.int.test.ts`(`DrizzleEventRefundStore.updateLocked` 둘을 `Promise.all`로, 그리고 다른 연결이 `select … for no key update`로 행을 잡은 열린 트랜잭션 안에서 PORTONE 멈춤을 쓰는 동안 부름) | 두 경우 모두 TOSS·PORTONE 둘 다 PAUSED. 잡힌 동안 `updateLocked`는 200ms 안에 끝나지 않고, 커밋 뒤 끝나며 `next`가 받은 값에 PORTONE이 있다. TOSS만 재개한 뒤 `claimOrders`는 PORTONE 항목을 주지 않는다 | 예(메서드 없음) |
| `GAT-110 N8 실제 DB에서 겹친 두 실행이 다른 결제사를 멈춘 뒤 TOSS만 재개해도 PORTONE 결제사 호출은 0이다` | 통합·차례 `test-int/event-cancel-r-t24.int.test.ts`(위 단위 첫 N8 시험을 실제 저장소·실제 잡기로. A의 둘째 `claimOrders`만 감싸 막대로 멈춘다, 잡기는 주문 차례대로 O1 → O2) | O1 취소 ID의 결제사 호출 0, DB `progress`의 PORTONE PAUSED | 예 |
| `GAT-110 P3 그 밖 실패(업무 거절 목록 밖, 시도 상한 전)로 끝난 항목도 팬 실패 알림 하나를 같은 쓰기에 남긴다` | 단위·차례(취소기 대역이 첫 시도에 `{ status: 'FAILED', error: 'NOT_FOUND' }`) | 항목 FAILED·attempts 1·다음 시각 빔, `trade.orders` `REFUND_FAILED` 1(업무 거절 길의 알림과 같은 꼴·같은 중복 제거 키 규칙), 행 실패 표시 1, `failure_case_at` 있음, 시도 기록 FAILURE 1, 처리 중 CS 호출 0. 대조: 결과 모름 재시도는 알림 0, 시도 상한 FAILED는 1(2가 아님) | 예(알림 0) |
| `GAT-110 P3 실제 DB에서 그 밖 실패의 끝내기를 실패시키면 항목 FAILED·팬 알림·failure_case_at이 모두 없다` | 통합·차례 `test-int/event-refund.int.test.ts`(끝내기 트랜잭션 안 Outbox 쓰기에 장애 주입) | 첫 틱: 셋 다 없음·항목 PENDING. 다음 틱(장애 없음): 셋이 한 커밋, Outbox 1 | 예(성공 쪽 Outbox 0) |
| `GAT-110 P3 연기 신청 Saga의 업무 실패 답(업무 거절 목록 밖)이면 항목 FAILED·팬 실패 알림 하나·CS 건 하나다` | 통합·차례 `test-int/event-cancel-r-t24.int.test.ts`(N7 묶음 옆, 실제 Saga. 답은 `CancelTicketEventRefund`가 `{ status: 'FAILED', error: <Saga 상태> }`로 주는 것 가운데 `FAILURE_ERRORS` 밖의 것, 예 `NOT_FOUND`) | 항목 FAILED, 팬 `REFUND_FAILED` 1, 틱 끝 CS 건 1(category `REFUND`), 다음 runDue 결제사 호출 0 | 예 |
| `GAT-110 P3 두 실행이 같은 그 밖 실패 항목을 겹쳐 끝내도 팬 실패 알림은 하나다` | 통합·동시 같은 파일(잡기를 잃은 쪽은 0행) | 팬 `REFUND_FAILED` 1, 경고 `event-refund-item-claim-lost` 1, CS 건 1 | 아니요(처음부터 통과 예상, 표본 M-P3c로 실패를 본다) |

- 자주 놓친 결함 대 본 것: 장애 주입이 실제로 끼어들었는지(N3은 둘째 실행의 잡기 호출 수와 `claimed_until` 값으로, N8은 끼운 쓰기가 DB에 먼저 있는지를 먼저 단언), 경계(남은 기한 39,999/40,000ms, 늘리기 59,999/60,000ms), 목록 밖 값(`NOT_FOUND` 같은 목록 밖 실패 답, 기한 지난 잡기, 다른 잡기 값), 복구 경로(늘리기를 잃은 주문을 다음 실행이 집음, 재개 뒤 남은 결제사), 겹친 가드는 하나씩(늘리기 조건의 잡기 값·기한·상태, 합치기의 더하기·빼기·사유를 따로 뺀다).
- 정본 시험 표(transfer-refund §11)에는 줄을 더하지 않는다. 장부 범위는 그대로다.

### 4. 틀린 구현 표본(검증 담당이 넣을 것)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| M-N3a | 늘리지 않는다(옛 동작) | N3 표 셋 단위·통합 |
| M-N3b | 기준 비교를 `<`에서 `<=`로(40,000ms 정각에도 늘림) / 기준을 표 한도 30,000ms로 / 운영 조립의 `deadlineMs`가 상수 밖 값(예 45초) | N3 기준 경계, N3 상수·조립 |
| M-N3c | 늘리기 문장에서 `claimed_until > 지금`을 뺀다(지난 잡기를 되살림) / 잡기 값 조건을 뺀다 | N3 DB 문장(정각·다른 값) |
| M-N3d | 늘리기가 0행이어도 그 표를 보낸다 | N3 0행 |
| M-N8a | 실행 끝이 그 실행이 아는 목록으로 통째로 쓴다(옛 `updateActive`) | N8 겹친 두 실행 단위·통합 |
| M-N8b | 실행 끝이 `newlyPaused`가 아니라 그 실행의 멈춤 목록 전부를 더한다 | N8 늦게 끝난 실행(되살림) |
| M-N8c | 한꺼번에 재개가 잠근 값의 모든 멈춤을 뺀다 / 창 닫기·수동 멈춤이 읽은 값으로 그대로 쓴다 | N8 한꺼번에 재개, N8 창 닫기·수동 멈춤 |
| M-N8d | `updateLocked`가 잠그지 않고 읽은 뒤 쓴다 | N8 DB 동시(잡힌 동안 기다림) |
| M-N8e | 합치기가 자동 사유로 DB 사유를 덮는다 / MANUAL이 사유를 바꾸지 못한다 | N8 합치기 표, N8 수동 멈춤 |
| M-P3a | `#retryOrFail`의 FAILED 쓰기가 Outbox 없이 남는다(옛 동작) | P3 단위·통합 |
| M-P3b | Outbox를 끝내기 뒤 따로 쓴다(같은 트랜잭션이 아님) | P3 장애 주입 |
| M-P3c | 알림을 `#finishItem` 밖에서 한 번 더 남긴다 / 잡기를 잃은 쪽도 남긴다 | P3 대조(상한 1), P3 동시 |

### 5. 돌릴 시험

단위(시험·구현 담당이 자기 폴더에서):

```
cd D:/ticketpass-w9-fix1/services/purchase-svc && node_modules/.bin/vitest run test/event-refund-claim-pause.test.ts test/event-refund-wave-review.test.ts test/event-refund-gat130.test.ts test/event-refund.test.ts test/event-refund-order-serial.test.ts test/event-refund-sweep.test.ts
```

통합(Docker, 감독이 잠금을 잡은 때만). ops-svc 코드는 바꾸지 않는다.

```
cd D:/ticketpass-w9-fix1/services/purchase-svc && node_modules/.bin/vitest run --config vitest.integration.config.mjs test-int/event-refund.int.test.ts test-int/event-cancel-r-t24.int.test.ts test-int/event-refund-grpc.int.test.ts test-int/relay-app.int.test.ts
```

### 6. 정본 빈칸과 정한 것(이 커밋에서 정본에 씀, 모두 '추천 적용 2026-11-17, W9-fix1')

| 빈칸 | 정한 것 | 쓴 곳 |
| --- | --- | --- |
| 잡기 기한을 늘리는 법 | 표를 보내기 직전, 남은 기한 < 40초 [가정](표 한도 30초 [가정] + 끝내기 여유 10초 [가정])이면 살아 있는 잡기만 한 문장으로 지금 + 60초. 0행이면 보내지 않음. 심장박동은 쓰지 않음. 60 > 40 > 30 | transfer-refund §5 '잡기 늘리기', data `claimed_until`·§5 K2 줄 |
| 진행률 병합 규칙 | 요청 행 잠금 안에서 DB 멈춤에 더하고 빼기만. 실행 끝은 새 자동 정지만 더함, 빼기는 재개만(한꺼번에면 재개가 읽은 것만), 이미 멈춘 결제사는 DB 사유, MANUAL만 사유를 바꿈, PAUSED면 상태 그대로 | transfer-refund §5 '멈춤 표시는 합쳐 쓴다', data §5 새 줄, ASVS 15.2.2 |
| 그 밖 실패의 FAILED 알림 꼴 | 다른 FAILED 길과 같다: 끝내기 트랜잭션에 그 주문의 `trade.orders` `REFUND_FAILED` 하나(요청·표·종류로 정해지는 중복 제거 키). 끝내기는 시도 상한과 같은 길 | transfer-refund §5 '주인' |

## 실패 확인

시험 담당 `w9f1-test`(claude-opus-5-5), 2026-11-17. 계획 §3의 재현 시험 17(단위 10, 통합 7)을 구현 전에 썼다(시험 커밋 `3881012d`). 기준은 `79e9073f`의 제품 코드다(동작은 바꾸지 않고 빈 뼈대만 더함). 단언 값은 정본(transfer-refund §5 '잡기 늘리기'·'멈춤 표시는 합쳐 쓴다'·'주인', data `event_refund_item.claimed_until`·§5)과 계획 §3에서 가져왔다. 시험 이름은 계획대로 `GAT-110 N3`·`GAT-110 N8`·`GAT-110 P3`로 시작한다(감독 지시의 예는 `GAT-090 P3`였지만 계획 §1~3이 P3을 GAT-110 범위로 적어 계획을 따랐다).

**돌린 명령과 결과**

| 명령 | 결과 |
| --- | --- |
| purchase-svc `node_modules/.bin/tsc --noEmit` | 바꾼 파일·새 시험 오류 0. `../queue-svc`의 `@peaket/shuffle` 모듈 찾기 오류 7은 이 작업 폴더에 그 패키지 `dist`가 없어서 생기는 기존 것(이 묶음과 무관) |
| 뿌리 `node_modules/.bin/eslint`(바꾼 `src` 여섯 파일) | 오류 0(시험 파일은 설정상 제외) |
| purchase-svc `node_modules/.bin/vitest run`(단위 전체) | 시험 파일 129, 시험 4,128: 실패 10(모두 새 시험), 통과 4,118. 손대지 않은 기존 시험에 새로 깨진 것 0 |
| 계획 §5 단위 명령(여섯 파일) | 104: 실패 10, 통과 94 |
| 도커 잠금 2026-11-17 17:24~17:26 KST. 계획 §5 통합 명령(네 파일) | 시험 78: 실패 11, 통과 67. 실패 = 새 시험 7 + 기존 시험 4(아래 '기존 시험의 시계 의존 실패', 이 묶음과 무관). `event-refund-grpc.int`·`relay-app.int`는 모두 통과 |

- 컨테이너: 시험이 띄운 PostgreSQL은 시험 끝에 스스로 지웠다(돌리기 앞뒤 `docker ps -a` 목록이 같음). 잠금 폴더·owner.txt는 지웠다.

**실패 수와 까닭(새 시험 17 모두 실패, 까닭은 모두 '아직 구현 안 됨')**

| 시험(파일) | 지금 결과 | 까닭 |
| --- | --- | --- |
| `GAT-110 N3 표 셋이 각 25초 …`(단위 `test/event-refund-claim-pause.test.ts`) | 실패 | 늘리지 않아 잡은 때 + 75,000ms에 기한(+ 60,000ms)이 지나 둘째 실행이 셋째 표를 잡음(잡은 항목 1, 셋째 표 호출 2) |
| `GAT-110 N3 늘리기 기준은 남은 기한 40,000ms 미만이다`(단위) | 실패 | 남은 39,999ms에도 `extend` 호출 0 |
| `GAT-110 N3 늘리기가 0행이면 …`(단위) | 실패 | `extend`를 부르지 않아 둘째·셋째 표를 보냄 |
| `GAT-110 N3 잡기 60초 > 늘리기 기준 40초 > 표 한도 30초 …`(단위 `test/event-refund-wave-review.test.ts` '운영 시작 검사') | 실패 | 상수는 빈 뼈대로 생겼지만 `relay-app.ts`·`start.ts`의 `deadlineMs`가 `+ 30_000` 글자 그대로(상수를 안 씀) |
| `GAT-110 N3 실제 DB에서 API 파드의 느린 주문 처리와 리더 runDue가 겹쳐도 …`(통합 `test-int/event-cancel-r-t24.int.test.ts`) | 실패 | 셋째 표 전 `claimed_until` = 잡은 때 + 60,000ms(늘리지 않음). 장애 주입 확인(셋째 호출 안에서 리더가 돎)은 통과 |
| `GAT-110 N3 잡기 늘리기는 잡기 값이 같고 기한 안일 때만 …`(통합 `test-int/event-refund.int.test.ts`) | 실패 | `DrizzleEventRefundClaims.extend`가 빈 뼈대(던짐). 잡기의 `claimedUntilMs` = 잡은 때 + 60,000ms와 끝내기 뒤 행 값은 맞음 |
| `GAT-110 N8 겹친 두 실행이 서로 다른 결제사를 자동 정지하면 …`(단위) | 실패 | A의 `updateActive`가 0행이라 PORTONE 멈춤이 사라짐(저장된 멈춤 TOSS 하나). 장애 주입 확인(B의 PAUSED{TOSS}가 먼저)은 통과 |
| `GAT-110 N8 재개 전에 시작한 실행이 늦게 끝나도 …`(단위) | 실패 | A가 처음 본 TOSS로 PAUSED{TOSS}를 다시 씀 |
| `GAT-110 N8 한꺼번에 재개는 재개가 읽은 멈춤만 빼고 …`(단위) | 실패 | 재개가 읽은 목록으로 통째로 써 끼운 PORTONE 멈춤이 지워짐(그 뒤 PORTONE 표 호출 1) |
| `GAT-110 N8 신청 창 닫기·수동 멈춤은 …`(단위) | 실패 | 창 닫기가 읽은 값으로 RUNNING을 써 TOSS 멈춤이 지워지고, 같은 틱에 신청 표를 보내 COMPLETED |
| `GAT-110 N8 멈춤 합치기: …`(단위) | 실패 | `mergePauses`가 빈 뼈대(던짐) |
| `GAT-110 N8 실제 DB에서 두 끝 쓰기가 같은 순간에 와도 …`(통합 `event-refund.int`) | 실패 | `DrizzleEventRefundStore.updateLocked`가 빈 뼈대(던짐) |
| `GAT-110 N8 실제 DB에서 겹친 두 실행이 …`(통합 `event-cancel-r-t24.int`) | 실패 | DB `progress`에 PORTONE 멈춤 없음(TOSS 하나). 장애 주입 확인은 통과 |
| `GAT-110 P3 그 밖 실패(업무 거절 목록 밖, 시도 상한 전)로 …`(단위) | 실패 | `#retryOrFail`의 FAILED 갈래가 다음 시각을 채우고 팬 알림 Outbox를 쓰지 않음 |
| `GAT-110 P3 실제 DB에서 그 밖 실패의 끝내기를 실패시키면 …`(통합 `event-refund.int`) | 실패 | 끝내기에 Outbox 쓰기가 없어 장애 주입이 끼어들지 못함(첫 틱 runDue가 던지지 않고 항목이 FAILED로 커밋) |
| `GAT-110 P3 연기 신청 Saga의 업무 실패 답 …`(통합 `event-cancel-r-t24.int`) | 실패 | 팬 `REFUND_FAILED` 0. 항목 FAILED(`NOT_FOUND`)·Saga 호출 1은 맞음 |
| `GAT-110 P3 두 실행이 같은 그 밖 실패 항목을 겹쳐 끝내도 …`(통합 `event-cancel-r-t24.int`) | 실패 | 팬 `REFUND_FAILED` 0. 겹침(Saga 호출 2)은 실제로 일어남 |

- 시험 파일을 못 읽어 실행조차 안 된 실패는 없다.

**처음부터 통과한 것: 없음**

- 계획 §3은 `GAT-110 P3 두 실행이 같은 그 밖 실패 항목을 겹쳐 끝내도 …`를 '처음부터 통과 예상'으로 적었지만, 지금 코드는 그 갈래에서 팬 알림을 아예 쓰지 않아(0) 실패한다. 그래서 틀린 구현을 손으로 넣어 볼 필요가 없었다. 이 시험이 원래 잡으려던 M-P3c(알림을 끝내기 밖에서 한 번 더, 잡기를 잃은 쪽도 남김)는 구현 뒤 검증 담당이 넣어 본다.

**기존 시험의 시계 의존 실패(이 묶음과 무관, 감독 정리 목록 후보)**

- `event-refund.int`의 `BAT-420 다시 보기 2 N1·N2` 묶음 넷(`GAT-110 N1 실제 DB에서 답하지 않는 ops 대역에도 …`, `GAT-110 N2 일괄 환불 항목이 FAILED로 끝나면 …`, `GAT-110 N2 차액 건으로 대신한 항목에는 …`, `GAT-110 N2 한 요청의 일괄 환불 실패 항목 둘 가운데 …`)이 `TypeError: Cannot read properties of undefined (reading 'filter')`(`pausedOf` ← `#closeWindowNow` ← `runDue`)로 실패한다.
- 까닭: 같은 파일의 `확정된 회차 취소 찾기 [BAT-420 리뷰 D5]`가 SQL로 넣는 연기 요청의 `refund_window_closes_at`이 고정 시각 `NOW + 3일` = 2026-11-17T08:00Z(17:00 KST)이고 `progress`에 `perPg`가 없다. N1·N2 묶음은 진짜 시계(`Date.now()`)로 거르지 않은 `runDue`를 돌리므로, 그 시각이 지난 뒤로는 그 요청을 닫으려다 던진다. 내 새 시험(같은 파일 끝, 이 요청만 보는 저장소)은 이 영향을 받지 않는다.
- 고치는 길(시험 몫, 이 묶음에서는 하지 않음): D5의 연기 요청에 먼 기한·`perPg`를 넣거나, N1·N2의 서비스 저장소를 그 시험 요청으로 좁힌다.

**정한 것과 계획과 다르게 둔 곳**

- 단위 잡기 대역(`ClaimsDouble`, 새 단위 파일): 실제 `DrizzleEventRefundClaims` 규칙을 따른다(실행 중 요청만, 멈춘 결제사 제외, 그 주문에 살아 있는 잡기·기다리는 결과 모름이 없을 때만, 기한 = 지금 + 60초, 끝내기는 잡기 값·끝나지 않은 상태만 보고 기한은 안 봄, 늘리기는 같은 값·기한 > 지금·PENDING·UNKNOWN만). 잡기 차례는 저장소에 넣은 차례(실제 SQL은 표 ID 차례)다.
- N8 단위의 '읽은 뒤·쓰기 전에 끼우기'는 요청 쓰기(`update`·`updateActive`·`updateLocked`) 가운데 처음 오는 것 앞에 한 번 끼운다. 지금 코드와 고친 코드 모두에서 같은 자리에 끼우고, 끼웠는지(`injected`)를 먼저 단언한다. 그래서 구현은 진행률 쓰기를 `updateLocked`로 하면 되고, 그 앞에 따로 요청 쓰기를 더하면 끼우는 자리가 바뀐다.
- N8 '늦게 끝난 실행': 사람의 TOSS 재개는 첫 묶음 0인 조립(쓰기만, 처리 없음)으로 했다. 그래야 대조에서 SIMULATOR 정지를 A 혼자 판정한다. 잡기 차례는 PORTONE → SIMULATOR → TOSS.
- N8 '한꺼번에 재개'에 끼우는 PORTONE 멈춤의 사유는 `AUTO_FAILURE_RATE`(다른 실행의 1분 창)다. 재개하는 쪽 서킷이 닫혀 있어야 지금 코드에서 PORTONE 표가 불려 재현이 된다.
- N8 창 닫기: 계획의 단언에 '멈춘 결제사로 신청 표 호출 0'을 더했다(정본 §5 '사람이 재개하기 전에는 멈춘 결제사로 새 환불 호출이 나가지 않는다').
- N3 0행: '시도 기록 0'은 보내지 않은 둘째·셋째 표의 기록 0으로 읽었다(먼저 보낸 첫 표의 SUCCESS 1은 남는다).
- N3 상수·조립: 두 시작 파일의 `new EventRefundService(` 인자에서 `deadlineMs: () => <시계>.now() + EVENT_REFUND_TICKET_DEADLINE_MS`와 같은 시계의 `nowMs: () => <시계>.now()`를 소스 글로 본다. 글자 그대로의 `30_000`도 실패다(계획 ⑤ '상수를 빼고 두 운영 조립의 deadlineMs가 쓴다').
- P3 단위는 잡기를 꽂은 조립과 옛 조립(잡기 없음) 둘 다 본다. 시도 상한 대조는 항목 시도 수를 4로 둔 뒤 한 번 더 실패시킨다.
- P3 통합 장애 주입은 그 회차의 `outbox` 넣기에 BEFORE INSERT 트리거로 예외를 낸다. Drizzle이 질의 오류를 `DrizzleQueryError`로 감싸므로 오류 사슬(`cause`)에서 `injected p3`를 찾는다. '셋이 한 커밋'은 첫 틱에 셋 다 없고 다음 틱에 셋 다 있는 것으로 본다(행의 트랜잭션 ID 비교는 실행 끝의 잡기 풀기가 같은 항목 행을 다시 쓰므로 쓰지 않았다).
- P3 연기 신청 Saga의 `NOT_FOUND`는 Saga의 주문 조회 어댑터에 그 회차 판매 설정이 없게 해서 만든다(대상 조회는 정상 설정). 결제사·ticket-svc는 부르지 않는다.
- 통합 새 묶음은 다른 시험의 1분 창·잡기와 겹치지 않게 먼 시각(`event-refund.int` NOW + 20일, `event-cancel-r-t24.int` NOW + 40일)에서 돌고, `runDue`는 그 시험 요청만 보는 저장소로 좁혔다.
- 시험 담당은 제품 코드를 쓰지 않으므로, 맞는 구현에서 새 시험이 통과하는지는 확인하지 못했다(참고 구현을 시도했지만 역할 밖이라 막혔다). 소스 글 검사만 따로 확인했다: 지금 글은 실패, 상수로 바꾼 글은 통과, `45_000`은 실패.

**더한 빈 뼈대(동작 없음)**

- `domain/event-refund-ports.ts`: `EVENT_REFUND_TICKET_DEADLINE_MS = 30_000`·`EVENT_REFUND_CLAIM_EXTEND_BELOW_MS = 40_000`, `EventRefundClaims.extend`, `claimOrders` 반환의 `claimedUntilMs`, `EventRefundStore.updateLocked`.
- `adapters/db/drizzle-event-refund-claims.ts`: `claimOrders`가 `claimedUntilMs`(= nowMs + 잡기 기한, 이미 계산하던 값)를 싣는다. `extend`는 던진다.
- `adapters/memory-event-refund-store.ts`·`adapters/db/drizzle-event-refund-store.ts`: `updateLocked`는 던진다. `domain/event-refund.ts`: `mergePauses`는 던진다. `index.ts`: 상수 둘·`mergePauses` 내보내기.
- 고친 기존 시험(통과 그대로): `test/event-refund-wave-review.test.ts`의 잡기 대역에 `claimedUntilMs`·`extend`(살아 있는 잡기로 답함).
