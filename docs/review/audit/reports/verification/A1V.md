# A1V R-605 수정 검증(독립)

- 검증 대상: `4a2fd11b`(R-605, 2026-11-15 11:08) + 검증 목록에 포함된 `b52e9e5f`(R-607, 2026-11-15 11:14)
- 작업 위치: `D:\ticketpass-fix-payment` 읽기 전용. 변이·표적 시험은 격리 임시 worktree `C:\Users\ghwnd\AppData\Local\Temp\opencode\peaket-a1v-r605`에서 수행하고 원복했다.
- 금지 준수: 메인 `D:\ticketpass`·소유자 미추적 파일 접근 없음, 커밋·푸시·Docker 없음. 전체 빌드 없음.
- **중요한 상태 불일치**: 시작할 때 `D:\ticketpass-fix-payment`의 HEAD는 `4a2fd11b`가 아니라 `b52e9e5f`(R-607)였고, 추적 파일 5개가 이미 수정되어 있었다. 검증 중 다른 세션이 `0ab87d48`(R-613)을 커밋해 **현재 HEAD는 `0ab87d48`이고 `git status --short`는 깨끗하다**. R-605(`4a2fd11b`)·R-607(`b52e9e5f`)의 정확한 검증은 격리 worktree에서 했고, R-613은 그 위에 추가된 후속 수정이다. R-613은 A1V-05·A1V-06을 고쳤고, A1V-01·02·03·04·07·08·09·10·11·12·15는 남아 있다.

## 판정 요약

| 항목 | 판정 | 핵심 |
| --- | --- | --- |
| A2-01 상품 원천 query | **통과** | `query: {from,to}`로 보내고 가짜 core 200으로 계산. `params` 변이를 시험이 잡음 |
| A2-05 HELD/DISPUTED 재확정 | **부분 통과** | KYC·SCHEDULED 경로는 통과. BALANCE 등 다른 HELD 사유와 실제 DISPUTED 이의를 구분하지 못함(R-613에서도 남음) |
| A2-06 event-calculations·스케줄러 | **부분 통과** | 내부 경로는 배선·시험됨. 스케줄러는 5영업일 규칙이 문서와 다르고, R-605/R-607은 STANDARD만 계산(R-613이 ESCROW 수정). `start.ts` 배선 시험이 없음 |
| M1-F1 원자적 배치 | **부분 통과** | Drizzle 트랜잭션은 있음. 그러나 한 배치 안에서 같은 미수금을 두 번 상계하는 결함을 R-613에서도 재현. 승인 전 SCHEDULED 전이는 R-613이 release로 완화 |
| M1-F2 다른 결제사 배상 상계 | **부분 통과** | `COMPENSATION_ADVANCE`를 결제사 무관하게 상계하는 쿼리는 맞음. 다중 정산서에서 이중 상계 결함이 그대로 발생 |
| M1-F3 confirmDue 워커 | **부분 통과** | `confirmDueStatements` 자체는 동작. 워커의 호출·내부 경로는 시험이 없고, `calculateDueEvents` 실패에 묶여 있음 |

## 실행한 시험

- `4a2fd11b`에서:
  - `pnpm.cmd --filter @peaket/payment-svc exec vitest run test/settlement-http-source.test.ts test/settlement.test.ts` → **2 files, 18 tests 통과**
  - `pnpm.cmd --filter @peaket/ops-svc exec vitest run test/payout-approval.test.ts` → **1 file, 7 tests 통과**
- `b52e9e5f`에서:
  - `pnpm.cmd --filter @peaket/payment-svc exec vitest run test/settlement.test.ts test/settlement-http-source.test.ts` → **2 files, 20 tests 통과**
- 임시 검증(격리 worktree, 실행 뒤 삭제):
  - 이중 상계: **실패(결함 재현)** — `batchTotal=78,000`, 기대 128,000, `moves=[50,000,50,000]`, `remaining=0`
  - 재확정: **3개 통과(결함 확인)** — BALANCE HELD → CONFIRMED, PAID → 409, DISPUTED → CONFIRMED인데 이의 row는 `result=null`
  - 스케줄러 지급일: **실패(결함 재현)** — `payoutDate=2026-11-20`, 문서 기대 2026-11-13
- 현재 `0ab87d48`(R-613)에서:
  - `pnpm.cmd --filter @peaket/payment-svc exec vitest run test/settlement.test.ts test/settlement-http-source.test.ts` → **2 files, 25 tests 통과**
  - `pnpm.cmd --filter @peaket/ops-svc exec vitest run test/payout-approval.test.ts` → **1 file, 8 tests 통과**
  - 검증 중 R-613 커밋 전에는 `settlement.test.ts` 22개 중 2개가 빨간색이었다(`A1-H3 CANCELED` 기대 0 vs 실제 -10,000). R-613이 그 미커밋 변경을 커밋하며 해소했다. 이는 `4a2fd11b`·`b52e9e5f`의 실패가 아니다.

## 변이 결과

| 변이 | 표적 시험 | 결과 |
| --- | --- | --- |
| `HttpProductSettlementSource`의 `query`를 `params`로 되돌림 | `settlement-http-source.test.ts` | **잡힘**: 422 → `product-settlement-source-unavailable`로 실패 |
| `POST /internal/v1/settlements/event-calculations` 제거 | `settlement.test.ts`의 A2-06 내부 경로 | **잡힘**: 404 |
| `start.ts`의 `settlementDueWorker?.start()` 제거 | payment 정산 시험 전체 | **살아남음**: 18/20개 모두 통과. 스케줄러 배선 시험 없음 |
| `SettlementDueWorker.tick()`의 `confirmDueStatements` 호출 제거 | payment 정산 시험 전체 | **살아남음**: 20개 모두 통과. `M1-F3`는 메서드를 직접 부르고 워커 호출은 보지 않음 |
| `createPayoutBatchAtomically`의 상계 트랜잭션 분리 | `settlement.int.test.ts` M1-F1 | **실행 불가**: Docker 필요. 단위 시험은 이 변이를 보지 못함(메모리 저장소가 원자적이지 않음) |

---

## 발견

### [높음] A1V-01: 한 지급 묶음 안에서 같은 미수금이 여러 정산서에 이중 상계된다
- 영역/배치: M1-F1·M1-F2, R-607
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:335-355`(정산서마다 `listOpenReceivables`를 다시 읽고 `receivableUpdates`에 넣음), `services/payment-svc/src/modules/settlement/adapters/db/drizzle-settlement-store.ts:296-305`(같은 미수금에 대한 중복 update를 순서대로 적용)
- 증거: `b52e9e5f`에서 두 정산서(각 89,000원)와 미수금 50,000원으로 `createPayoutBatch`를 호출하면 `batchTotal=78,000`, `moves=[50,000,50,000]`, `remaining=0`이 나온다. 올바른 값은 128,000원과 이동 기록 50,000원 한 줄이다.
  - 원인: `createPayoutBatch`는 미수금을 메모리 `receivableUpdates`에만 쌓고 DB에 쓰지 않는다. 다음 정산서의 `listOpenReceivables`는 아직 커밋되지 않은 DB를 읽어 같은 `remaining`을 다시 본다. `createPayoutBatchAtomically`는 그 중복 update를 순서대로 적용해 마지막 값만 남긴다.
  - 시험 `M1-F2`(단위·통합)는 정산서가 하나뿐이라 이 결함을 잡지 못한다.
  - **R-613(`0ab87d48`)에서도 같은 시험을 다시 돌려 `batchTotal=78,000`, `moves=[50,000,50,000]`을 재현했다.** R-613의 초록(25 tests)은 이 경로를 보지 않는다.
- 왜 문제인가: 파트너가 실제로 받아야 할 돈보다 50,000원 적게 받는다. 미수금 이동 기록 합이 미수금 금액을 넘어 M3 불변식도 깨진다. R-607의 "한 트랜잭션"은 원자성만 보장하고, 이중 상계는 막지 못한다.
- 재현/확인: 격리 worktree에서 두 정산서 + 미수금 50,000원 시험 → `{"batchTotal":78000,"moves":[50000,50000],"remaining":0}`. 시험 파일은 실행 뒤 삭제했다. R-613 현재 트리에서도 같은 결과.
- 제안 수정: 상계 루프 안에서 이미 상계한 미수금의 남은 금액을 로컬 맵으로 차감해 다음 정산서가 보게 하거나, 미수금 행을 `SELECT ... FOR UPDATE`로 잠그고 정산서별로 즉시 갱신한다. `receivableUpdates`를 미수금별로 합쳐 한 번만 쓰고, 이동 기록 합이 `amount`를 넘지 않는지 트랜잭션 안에서 검사한다. 정산서 2개 + 미수금 1개 시험을 단위·통합에 넣는다.
- 확신도: 높음

### [높음] A1V-02: 회차 스케줄러가 "종료 5영업일 뒤"에 계산해 지급일이 약 1주 늦어진다
- 영역/배치: A2-06, R-605
- 위치: `services/payment-svc/src/modules/settlement/application/settlement-due-worker.ts:62-66`(`through = dateOnly(subtractBusinessDays(now, 5))`), `services/payment-svc/src/modules/settlement/application/settlements.ts:165-177`(`calculateDueEvents`), `services/payment-svc/src/modules/settlement/domain/settlement.ts`의 `payoutDate = dateOnly(addBusinessDays(now, 5))`
- 증거: 문서 `docs/features/settlement.md:93`는 "회차가 끝난 다음 영업일 06시에 계산"한다. 5영업일은 §5.1의 **지급일**이지 계산 시점이 아니다. 그런데 워커는 `now - 5영업일`을 `through`로 넘겨, 종료 5영업일이 지난 회차만 계산한다.
  - 2026-11-08 종료 회차, 2026-11-14(토) 스케줄러 실행 → 정산서 `payoutDate=2026-11-20`. 문서대로면 2026-11-09(월) 계산, 종료+5영업일인 2026-11-13(금) 지급이다.
  - `A2-06` 시험 이름도 "회차 종료 5영업일 뒤 회차를 계산한다"로 잘못된 규칙을 단언하고, `payoutDate`는 확인하지 않는다.
- 왜 문제인가: 정산서가 4영업일 늦게 생겨 2영업일 이의 기간과 승인·지급 준비가 압축되거나, `calculateEventStatement`가 계산일+5영업일을 지급일로 잡아 실제 지급이 종료+10영업일로 밀린다. 파트너 지급이 약 1주 늦어진다.
- 재현/확인: 격리 worktree에서 이벤트 종료 2026-11-08, NOW 2026-11-14로 `SettlementDueWorker.tick()` → `payoutDate=2026-11-20`, 기대 2026-11-13.
- 제안 수정: 스케줄러는 "회차 종료 다음 영업일"에 계산하도록 `through`를 `now`(또는 전날)로 바꾸고, 06:00 KST에 맞춘다. `calculateEventStatement`는 이벤트 종료일을 입력으로 받아 `종료일+5영업일`을 지급일로 계산한다. 시험은 `payoutDate`까지 단언한다.
- 확신도: 높음

### [높음] A1V-03: DISPUTED 정산서를 이의를 풀지 않고 CONFIRMED로 되돌린다
- 영역/배치: A2-05, R-605
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:246-268`(`reconfirmStatement`가 `DISPUTED`를 그대로 `CONFIRMED`로 씀), `services/payment-svc/src/modules/settlement/inbound/internal-settlement.controller.ts:62-68`(재확정 라우트)
- 증거: `statement_dispute` row를 `result=null`, `resolvedAt=null`로 넣고 정산서를 `DISPUTED`로 만든 뒤 `reconfirmStatement`를 부르면 `CONFIRMED`가 되고, 이의 row는 여전히 `null`이다. 감사 로그·이벤트도 없다.
  - `A2-05` 시험은 `store.saveStatement({status:'DISPUTED'})`만 하고 실제 `statement_dispute` row를 만들지 않아 이 경로를 보지 않는다.
  - 문서 §4.2는 이의가 맞으면 수기 조정, 아니면 기각 사유를 적어 다시 알리고 1영업일을 준다고 한다. 재확정은 이 절차를 건너뛴다.
- 왜 문제인가: 파트너가 이의를 제기한 정산서를 답하지 않은 채 확정·지급할 수 있다. 이의 처리·감사 기록이 사라지고, 분쟁이 나중에 터진다.
- 재현/확인: 격리 worktree에서 `statement_dispute(result=null)` + `DISPUTED` → `reconfirmStatement` → `CONFIRMED`, dispute `result=null`. 시험 파일은 실행 뒤 삭제했다.
- 제안 수정: `DISPUTED`는 `statement_dispute`의 기각/조정 결과가 있을 때만 `NOTIFIED`로 되돌리고, 1영업일 이의 기간을 새로 준다. 재확정은 HELD(KYC/계좌)만 허용한다. 상태 전이 감사 로그를 남긴다. 실제 dispute row가 있는 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-04: HELD(BALANCE·ACCOUNT_MISMATCH·SALE_SUSPENDED)를 근거 없이 CONFIRMED로 되돌린다
- 영역/배치: A2-05, R-605
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:246-268`(`holdReason`이 `KYC`/`ACCOUNT_CHANGE`일 때만 검사)
- 증거: `holdReason='BALANCE'`인 HELD 정산서를 `reconfirmStatement`로 부르면 409 없이 `CONFIRMED`가 된다. `ACCOUNT_MISMATCH`·`SALE_SUSPENDED`도 같다.
- 왜 문제인가: 잔액 부족·계좌 불일치·판매 중지가 아직 풀리지 않았는데 정산서를 확정한다. 이후 `createPayoutBatch`가 다시 HELD로 돌리거나, 잘못된 상태로 지급 흐름에 들어간다. A2-05의 "보류 복구"가 KYC/계좌 변경만 복구해야 하는데 모든 HELD를 연다.
- 재현/확인: BALANCE HELD → `reconfirmStatement` → CONFIRMED(임시 시험 통과).
- 제안 수정: HELD 사유별 복구 조건을 명시한다. BALANCE는 잔액 확인, ACCOUNT_MISMATCH는 계좌 대조 일치, SALE_SUSPENDED는 판매 재개 확인을 통과해야 CONFIRMED로 바꾼다. 사유별 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-05: 지급 묶음 생성이 정산서를 승인 전에 SCHEDULED로 바꿔 반려 시 고착된다 — R-613에서 수정됨
- 영역/배치: M1-F1, R-607
- 위치: `services/payment-svc/src/modules/settlement/adapters/db/drizzle-settlement-store.ts:331-338`(결속 update가 `status='SCHEDULED'`로 씀), `services/payment-svc/src/modules/settlement/application/settlements.ts:350-375`(묶음은 `PENDING_APPROVAL`), `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:147-159`(반려는 승인 레코드만 바꿈)
- 증거: `createPayoutBatch`는 묶음을 `PENDING_APPROVAL`로 만들면서 정산서는 `SCHEDULED`로 결속한다. commander가 반려해도 payment-svc 묶음은 `PENDING_APPROVAL`로 남고, 정산서는 `SCHEDULED`라 `reconfirmStatement`가 409로 거절한다. 같은 날짜·상점 재요청도 `payout-batch-exists` 409다.
  - **R-613(`0ab87d48`)이 `releasePayoutBatch`와 ops 반려 시 `releaseBatch` 호출을 추가해 이 고착을 푼다.** 다만 R-605/R-607 커밋 자체에는 없었다.
- 왜 문제인가: 반려 한 번으로 그 정산서와 지급일·상점이 DB 수작업 없이는 다시 열리지 않는다. `SCHEDULED`는 문서상 "결제사에 지급을 요청한 상태"인데 승인 전에 붙는다.
- 재현/확인: `createPayoutBatch` 직후 정산서 status `SCHEDULED`, 묶음 status `PENDING_APPROVAL`. 반려 뒤 `reconfirmStatement` 409.
- 제안 수정: 묶음 생성 시 정산서는 `CONFIRMED`로 두고 `payout_batch_id`만 결속한다. `SCHEDULED`는 승인·실행 단계에서 쓴다. 반려 시 묶음을 취소하고 결속을 푼다. 반려→재요청 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-06: R-605/R-607 스케줄러가 STANDARD만 계산해 ESCROW 결제를 누락·오분류한다 — R-613에서 수정됨
- 영역/배치: A2-06, R-605/R-607
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:169-177`(`pgStore: 'STANDARD'` 고정, `listEventPayments(e.eventId, pg)`에 상점 조건 없음)
- 증거: 스케줄러는 TOSS/PORTONE마다 STANDARD 정산서만 만든다. R-605/R-607의 `SettlementPaymentSource.listEventPayments`는 `(eventId, pg)`만 받고 `payment`에 `pg_store`도 없다. ESCROW 결제가 STANDARD 정산서에 섞이거나, 상점별로 나뉘어야 할 정산이 한쪽만 생긴다.
  - 검증 중 `D:\ticketpass-fix-payment`의 미커밋 변경이 `pgStore`를 추가하고 있었고, 이후 **R-613(`0ab87d48`)이 `payment.pg_store`(0018)와 두 상점 루프를 커밋해 고쳤다.** `4a2fd11b`·`b52e9e5f`에는 없다.
- 왜 문제인가: 굿즈 에스크로 결제분이 정산서에서 빠지거나 잘못된 상점 정산서에 들어간다. 파트너 지급이 누락되거나 중복된다.
- 재현/확인: `calculateDueEvents`가 `pgStore: 'STANDARD'`만 넘긴다. `payments.listEventPayments`에 상점 인자가 없다.
- 제안 수정: `payment`에 `pg_store`를 저장하고 `listEventPayments(eventId, pg, pgStore)`로 거른 뒤, 스케줄러가 두 상점을 모두 계산한다. 두 상점 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-07: 스케줄러 첫 tick이 리더 선출 전에 돌아 24시간 동안 실행되지 않을 수 있고 06:00 KST에 맞지 않는다
- 영역/배치: A2-06, R-605
- 위치: `services/payment-svc/src/modules/settlement/application/settlement-due-worker.ts:40-44`(`start()`가 즉시 `tick()`하고 24시간 간격), `services/payment-svc/src/start.ts:335-350`(`settlementDueElector.start()` 직후 `settlementDueWorker?.start()`), `packages/platform/src/lease.ts`의 `LeaseElector`(초기 `leader=false`, `start()`는 비동기 루프)
- 증거: `LeaseElector.start()`는 비동기로 첫 `step()`을 돌리고, `SettlementDueWorker.start()`는 그 직후 동기적으로 `tick()`을 부른다. 이때 `isLeader()`는 아직 false라 tick이 반환되고, 다음 tick은 24시간 뒤다. 리더가 된 뒤 바로 도는 콜백이 없다. 또한 간격이 24시간이라 06:00 KST에 맞지 않는다.
- 왜 문제인가: 배포·재시작 뒤 첫 정산이 하루 늦어질 수 있다. 정산 지연이 그대로 파트너 지급 지연이 된다.
- 재현/확인: `LeaseElector` 초기 `leader=false`; `worker.start()`의 `void this.tick()`는 `isLeader()`가 false면 즉시 반환. `onChange`를 쓰지 않는다.
- 제안 수정: `LeaseElector`의 `onChange`로 리더가 됐을 때 tick하거나, 시작 직후 리더가 될 때까지 짧은 간격으로 재시도한다. 06:00 KST에 맞춘 스케줄(예: 다음 06:00까지 지연)을 쓴다. 리더 전환 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-08: `confirmDue`가 `calculateDueEvents` 실패에 묶여 core 장애 시 자동 확정이 하루 밀린다
- 영역/배치: M1-F3, R-607
- 위치: `services/payment-svc/src/modules/settlement/application/settlement-due-worker.ts:62-71`(`calculateDueEvents` → `confirmDueStatements` 순서, 하나의 try/catch)
- 증거: `calculateDueEvents`가 core-svc 503/타임아웃으로 던지면 `confirmDueStatements`는 호출되지 않고 `catch`로 간다. 다음 tick은 24시간 뒤다. 이미 계산된 `NOTIFIED` 정산서의 자동 확정이 core 장애와 무관하게 밀린다.
  - 변이로 `confirmDueStatements` 호출을 지워도 payment 시험 20개가 모두 통과했다. 워커 호출을 검증하는 시험이 없다.
- 왜 문제인가: core-svc 장애가 정산서 확정·지급 일정을 하루 늦춘다. 자동 확정은 core 원천과 독립적으로 돌 수 있어야 한다.
- 재현/확인: 워커 `tick`에서 `calculateDueEvents`가 던지면 `confirmDueStatements`에 도달하지 않는다. 호출 제거 변이가 살아남는다.
- 제안 수정: `calculateDueEvents`와 `confirmDueStatements`를 각각 try/catch로 분리해 한쪽 실패가 다른 쪽을 막지 않게 한다. 워커가 두 메서드를 모두 부르는 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-09: core `settlement-due` 내부 경로가 공유 토큰 없이 열려 있다
- 영역/배치: A2-06, R-605
- 위치: `services/core-svc/src/modules/catalog/inbound/internal-sale-config.controller.ts:43-57`(`@Controller('internal/v1/events')`에 `InternalTokenGuard` 없음, `@Roles(['public'])`), `services/payment-svc/src/modules/settlement/adapters/http-due-event-source.ts:16-20`(토큰 헤더를 보내지만 core가 검사하지 않음)
- 증거: `GET /internal/v1/events/settlement-due?through=...`는 `eventId`·`promoterId`·`endsAt`을 모두 돌려준다. `InternalTokenGuard`가 없어 클러스터 안 어느 파드든 호출할 수 있다. 기존 `sale-config` 경로도 같은 패턴이지만, 새 경로는 종료된 모든 회차를 열거한다.
- 왜 문제인가: 내부 토큰을 신뢰 경계로 쓰는 다른 정산 경로와 달리, 이 경로는 토큰 없이 cross-tenant 회차 목록을 준다. 내부망 침해 시 정산 대상 회차를 열거할 수 있다.
- 재현/확인: 컨트롤러에 `UseGuards(InternalTokenGuard)`가 없고 `HttpDueEventSettlementSource`가 보내는 `x-peaket-internal-token`을 읽는 곳이 없다.
- 제안 수정: `InternalTokenGuard`를 붙이고 core의 `PEAKET_INTERNAL_TOKEN`을 검사한다. 기존 `sale-config` 경로도 같은 규칙으로 맞춘다. 토큰 없이 401/403 시험을 넣는다.
- 확신도: 높음

### [중간] A1V-10: 스케줄러 배선·confirmDue 호출 제거 변이를 시험이 잡지 못한다
- 영역/배치: A2-06·M1-F3 시험 증거
- 위치: `services/payment-svc/test/settlement.test.ts`의 A2-06 스케줄러 시험(워커를 직접 생성), `services/payment-svc/test/settlement.test.ts`의 M1-F3 시험(`svc.confirmDueStatements()` 직접 호출), `services/payment-svc/src/start.ts:335-350`
- 증거: `start.ts`의 `settlementDueWorker?.start()`를 지워도 18/20개가 통과했다. `SettlementDueWorker.tick()`의 `confirmDueStatements` 호출을 지워도 20개가 통과했다. 두 시험 모두 실제 배선을 보지 않는다.
- 왜 문제인가: 스케줄러나 자동 확정이 실수로 빠져도 CI가 초록이다. A2-06·M1-F3의 "배선" 주장을 시험이 보증하지 못한다.
- 재현/확인: 위 변이 2개를 격리 worktree에서 적용 → payment 정산 시험 전부 통과. 원복했다.
- 제안 수정: `start.ts`를 띄우는 통합 시험이나 `SettlementDueWorker`가 `Settlements`의 두 메서드를 호출하는지 확인하는 대역 시험을 넣는다. `start()`가 리더가 된 뒤 tick하는지도 시험한다.
- 확신도: 높음

### [중간] A1V-11: M1-F1 롤백 시험은 Docker 통합 시험뿐이고 메모리 저장소는 원자적이지 않다
- 영역/배치: M1-F1 시험 증거
- 위치: `services/payment-svc/src/modules/settlement/adapters/memory-settlement-store.ts:90-113`(`createPayoutBatchAtomically`가 검증 뒤 순서대로 set; 실패 시 되돌림 없음), `services/payment-svc/test-int/settlement.int.test.ts`의 M1-F1 시험(실제 PostgreSQL, Docker 필요)
- 증거: Drizzle `createPayoutBatchAtomically`는 `this.db.transaction`으로 묶여 있고, 통합 시험은 배치 PK 충돌을 주입해 정산서·미수금·이동 기록이 롤백되는지 본다. 그러나 이 시험은 Docker가 필요해 이번 검증에서 실행하지 못했다. 단위 시험이 쓰는 메모리 저장소는 중간 실패 시 앞선 set을 되돌리지 않아 원자성을 모사하지 않는다.
  - 통합 시험의 실패 주입은 배치 PK 충돌이라, 정산서 결속 update 단계의 실패(예: 다른 배치가 먼저 결속)는 직접 주입하지 않는다.
- 왜 문제인가: Docker 없이 도는 CI에서는 트랜잭션 분리 변이를 잡지 못한다. 메모리 저장소를 쓰는 단위 시험은 롤백을 검증하지 않는다.
- 재현/확인: 메모리 저장소 코드에 롤백/스냅샷이 없다. `settlement.int.test.ts` M1-F1은 `test-int`(Docker)에만 있다.
- 제안 수정: 메모리 저장소도 스냅샷/롤백을 구현하거나, 단위 시험에서 실패 주입이 가능한 저장소 대역을 쓴다. 통합 시험에 결속 단계 실패 주입을 더한다.
- 확신도: 높음

### [중간] A1V-12: 재확정 상태 전이에 감사 로그·이벤트가 없다
- 영역/배치: A2-05, R-605
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:246-268`(`reconfirmStatement`), `services/payment-svc/src/modules/settlement/inbound/internal-settlement.controller.ts:62-68`
- 증거: 재확정은 `saveStatement`만 하고 감사 로그·Outbox 이벤트를 남기지 않는다. `docs/features/settlement.md:309-319`는 정산서 상태 전이를 이벤트·감사 로그로 남긴다고 한다. R-605는 ops 지급 승인에는 감사 체인을 붙였지만, 정산서 재확정에는 붙이지 않았다.
- 왜 문제인가: 누가 언제 어떤 사유로 HELD/DISPUTED를 CONFIRMED로 풀었는지 사후에 알 수 없다. 돈이 나가는 상태 전이의 감사가 빈다.
- 재현/확인: `reconfirmStatement`에 audit/outbox 호출이 없다.
- 제안 수정: 재확정 사유·행위자·이전 상태를 감사 로그와 `trade.settlements` 이벤트에 남긴다. 시험에서 감사 기록을 확인한다.
- 확신도: 높음

### [낮음] A1V-13: A2-01 시험이 내부 토큰 헤더와 due 원천 HTTP를 보지 않는다
- 영역/배치: A2-01·A2-06 시험
- 위치: `services/payment-svc/test/settlement-http-source.test.ts`(상품 원천만), `services/payment-svc/src/modules/settlement/adapters/http-due-event-source.ts:15-24`(due 원천, HTTP 시험 없음)
- 증거: 상품 원천 시험은 `from`/`to` query와 200 계산만 본다. `x-peaket-internal-token` 헤더가 빠져도 통과한다. `HttpDueEventSettlementSource`의 `query: {through, limit}`를 검증하는 시험이 없다.
- 왜 문제인가: 내부 토큰 누락·due 원천 query 회귀를 CI가 잡지 못한다.
- 제안 수정: 가짜 core 서버에서 토큰 헤더와 due query를 단언한다.
- 확신도: 높음

### [낮음] A1V-14: `SettlementDueWorker.stop()`이 진행 중 tick을 기다리지 않는다
- 영역/배치: A2-06 종료
- 위치: `services/payment-svc/src/modules/settlement/application/settlement-due-worker.ts:46-51`(`stop()`은 interval만 지움), `services/payment-svc/src/start.ts`의 shutdown(`settlementDueWorker?.stop()`)
- 증거: `tick()`이 `calculateDueEvents`·`confirmDueStatements`를 await하는 중에 `stop()`이 불리면 interval만 지우고 반환한다. 이어서 서비스가 DB 풀을 닫으면 진행 중 tick이 닫힌 풀을 쓸 수 있다.
- 왜 문제인가: 종료 중 오류·미완 정산이 생길 수 있다.
- 제안 수정: 진행 중 tick promise를 보관해 `stop()`에서 await한다.
- 확신도: 중간

### [낮음] A1V-15: 반려 사유가 `payout_approval.reason_text`에 저장되지 않는다
- 영역/배치: R-605 ops 감사
- 위치: `services/ops-svc/src/modules/payouts/adapters/db/drizzle-store.ts:69-82`(`save`가 `reasonText`를 set하지 않음), `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:147-159`(반려 사유를 `reasonText`에 넣음)
- 증거: R-605는 반려 사유를 감사 체인 payload에는 남기지만, `payout_approval` 행의 `reason_text`는 갱신하지 않는다. 반려 뒤 다시 읽으면 원래 요청 사유가 보인다. `payout-approval.test.ts`는 메모리 저장소라 통과한다.
- 왜 문제인가: 관제 화면의 반려 사유와 DB가 어긋난다. 감사 체인에는 남지만 화면·조회는 원래 사유를 보여 준다.
- 제안 수정: `save`에서 `reasonText`를 갱신하거나 `rejection_reason` 별도 칸을 둔다. 실제 DB 시험을 넣는다.
- 확신도: 높음

---

## 남은 위험

- **가장 큰 위험은 A1V-01**이다. R-607의 원자적 트랜잭션은 부분 실패 롤백을 보장하지만, 한 배치 안에서 같은 미수금을 여러 정산서가 다시 읽는 문제를 고치지 않았다. 정산서 2개 이상 + 미수금 1개인 실제 운영 형태에서 파트너가 적게 받는다. R-613에서도 재현됐다.
- **A1V-02**는 스케줄러가 문서의 계산 시점을 잘못 해석한 것이다. 정산서가 5영업일 늦게 생기고 지급일이 종료+10영업일로 밀릴 수 있다. R-613에도 남아 있다.
- **A1V-03·A1V-04**는 A2-05의 "보류 복구"가 너무 넓다. DISPUTED를 이의 처리 없이 확정하고, BALANCE/ACCOUNT_MISMATCH/SALE_SUSPENDED를 근거 없이 푼다. R-613에도 남아 있다.
- **A1V-05**는 R-605/R-607에서 반려된 묶음의 정산서를 SCHEDULED로 고착시켰다. R-613의 `releasePayoutBatch`가 고쳤다.
- **A1V-06**은 R-605/R-607 시점에 ESCROW 정산이 빠진다. R-613이 `payment.pg_store`와 두 상점 루프로 고쳤다.
- **A1V-07·A1V-08·A1V-09·A1V-10·A1V-11·A1V-12·A1V-15**는 R-613에도 남아 있다. 스케줄러 첫 tick/06:00, confirmDue 결합, core 내부 경로 토큰, 배선 시험, 롤백 시험, 재확정 감사, 반려 사유 저장이 그렇다.
- **worktree 상태**: `D:\ticketpass-fix-payment`는 시작 때 `b52e9e5f`(R-607)에 추적 파일 5개가 수정된 상태였고, 검증 중 다른 세션이 `0ab87d48`(R-613)을 커밋해 **현재 HEAD `0ab87d48`, `git status --short` 깨끗**이다. 내가 만든 임시 시험 파일은 삭제했고 추적 파일은 건드리지 않았다. 현재 R-613은 초록(25+8 tests)이지만 A1V-01·02·03·04가 남아 있어 그대로 배포하면 안 된다.
- 격리 worktree `C:\Users\ghwnd\AppData\Local\Temp\opencode\peaket-a1v-r605`는 시험 뒤 제거했다.
