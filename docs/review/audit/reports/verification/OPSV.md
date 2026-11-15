# R-597 수정 검증 (독립)

- 검증자: 독립 검증 에이전트(구현 미참여)
- 작업 위치: `D:\ticketpass-lane2` (커밋 `1ae63462`, R-597)
- 기준: `fabbabac`(R-594) → `1ae63462`(R-597)
- 방법: 커밋 diff와 현재 파일을 직접 읽고, `pnpm --filter @peaket/ops-svc exec vitest run <파일>`로 표적 시험을 돌렸다. 요청된 4개 변이를 차례로 넣고 시험 결과를 확인한 뒤 `git checkout -- <파일>`로 원복했다. Docker는 쓰지 않았다(통합 시험은 실행하지 못했다).
- 한계: `test-int`는 PostgreSQL 컨테이너를 `docker run`으로 띄우므로(`services/ops-svc/test-int/postgres.ts:1-3`) 이번 검증에서는 실행하지 못했다. 통합 시험은 코드·SQL 정적 대조만 했다.

## 판정 요약

| 항목 | 판정 | 한 줄 근거 |
| --- | --- | --- |
| **OPS-01** 감사 체인 기록 | **부분 통과** | 요청·판정·확정·반려·정지·재개·지급 승인/실행/재시도에 `#audit` 호출이 모두 있다. 통합 시험 **코드**가 실제 `audit_chain` 행을 확인한다(Docker 금지로 이번엔 미실행). 다만 감사 append가 상태 저장과 **다른 트랜잭션**이라 실패 시 RUNNING/EXECUTING에 갇히고, 수기 포트원 실행은 감사하지 않는다(OPSV-01·03·04). |
| **M4-01** 지급 기한 | **통과(코드)** | 월요일 지급 → 금요일 15:00 KST, 화~금 → 전날, 토·일 → 직전 금요일. 시험은 월·화·토·일만 단언하고 수·목·금은 비어 있다(OPSV-06). 변이(하루 더 빼기)는 잡혔다. |
| **OPS-03/M4-08** 낙관적 잠금 | **통과(코드) / 시험 미보호** | Drizzle·메모리 저장소 모두 `version = r.version - 1` 조건이 있다. 그러나 지급 승인 시험은 메모리 저장소만 쓰고, Drizzle 저장소의 version 조건을 지운 변이가 **9/9 통과**했다(OPSV-02). |
| **OPS-04** 체크포인트 원자성 | **통과(코드) / 실제 DB 경합 시험 없음** | `createWithAudit`가 `audit_chain_head` 행을 `FOR UPDATE`로 잠그고 체크포인트 삽입 + `appendAuditIn`을 한 트랜잭션에 쓴다. 단위 시험은 가짜 `AtomicStore`만 쓰고, 통합 시험은 동시 생성을 보지 않는다(OPSV-07). |
| **OPS-07** 환불 전 RUNNING | **통과(코드, 순서)** | `refunds.start` 전에 `save(running)`을 조건부로 쓴다. 실패하면 JUDGED로 되돌린다. 다만 순서를 단언하는 시험이 없고, 크래시·감사 실패 시 RUNNING에 갇힌다(OPSV-08·09). |
| **SEC-02** 확정 재인증 | **통과** | 컨트롤러가 `x-reauth-token`을 읽어 `verify(token, {sessionId, act:'APPROVAL'})`를 부르고, 토큰 계정과 요청자 계정을 대조한다. 변이(검사 제거)는 SEC-02 시험에서 잡혔다. 패스키 요구·배선 취약점은 OPSV-05. |

## 실행한 시험

기준선(원복 뒤 재확인 포함):

```
pnpm --filter @peaket/ops-svc exec vitest run \
  test/event-cancellations.test.ts test/payout-approval.test.ts \
  test/audit-anchor.test.ts test/command-execution.test.ts
→ Test Files 4 passed, Tests 35 passed
```

```
pnpm --filter @peaket/ops-svc typecheck
→ exit 0 (tsc --noEmit)
```

변이 결과:

| 변이 | 바꾼 곳 | 실행한 시험 | 결과 |
| --- | --- | --- | --- |
| `appendAudit` 호출 제거(=`#audit` no-op) | `event-cancellations.ts`, `payout-approvals.ts` | event-cancellations, payout-approval | **잡힘**: 2 failed / 14 passed. `expected [] to deeply equal [EVENT_CANCELLATION_REQUESTED, …]`, `[PAYOUT_APPROVAL_REQUESTED, …]` |
| `approvalDueAt` 달력 하루 더 빼기(`-1`→`-2`) | `payout-approval.ts` | payout-approval | **잡힘**: M4-01 1 failed / 8 passed. 월요일 기대 `2026-11-13T06:00Z`, 실제 `2026-11-12T06:00Z` |
| Drizzle 지급 승인 `version` 조건 제거 | `payouts/adapters/db/drizzle-store.ts` | payout-approval | **놓침**: 9/9 passed. 시험이 `MemoryPayoutApprovalStore`만 쓰기 때문 |
| 회차 취소 확정 reauth 검사 제거 | `event-cancellations.ts` | event-cancellations | **잡힘**: SEC-02 1 failed / 6 passed. 토큰 없는 확정이 `RUNNING`으로 통과 |

원복 뒤 `git status --short`에서 내가 만진 `services/ops-svc/**` 변경은 0건이다(아래 '작업 상태' 참고).

---

## 발견

### [중간] OPSV-01: 감사 append가 상태 저장과 다른 트랜잭션이라, append 실패 시 회차 취소는 RUNNING, 지급 승인은 EXECUTING에 갇힌다
- 영역/배치: OPS-01 수정, ops-svc event-cancellations·payouts
- 위치:
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:101-105` — `save(running)` → `#audit(APPROVED)` → `try { refunds.start }`.
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:104-108` — `save(executing)` → `#audit(APPROVED)` → `try { approveBatch·executeBatch }`.
  - `services/ops-svc/src/modules/audit/audit.ts:78-89` — `appendAuditIn`는 별도 `database.transaction`이다.
  - `event-cancellations.ts:110-116`, `payout-approvals.ts:113-117` — 실패 시 되돌리기.
- 증거: `#audit`는 상태 저장이 커밋된 뒤 별도 트랜잭션으로 실행된다. `save(running)`이 성공하고 `#audit`가 던지면 `refunds.start`는 호출되지 않으며, 요청은 RUNNING이 된다. `approve`는 JUDGED/PENDING_APPROVAL만 받으므로 재시도가 409다(`event-cancellations.ts:89`). 지급 승인도 EXECUTING이 되면 `approve`가 409다(`payout-approvals.ts:96`). 반대로 `save(next)`/`save(done)` 뒤의 `#audit(STARTED/EXECUTED)`가 던지면 실제 환불·지급은 끝났는데 API는 실패를 돌려주고 감사에는 FAILED가 남는다(되돌리기 `save(back)`도 version 조건 때문에 실패한다).
- 왜 문제인가: 감사 append의 일시적 실패(같은 DB의 락 대기·연결 오류·`audit_chain_head` 누락)가 수만 건 환불 요청이나 지급 묶음을 **사람이 DB를 고치기 전까지 멈춘다**. 반대 방향은 성공한 돈 이동을 실패로 보고하게 만든다. OPS-01을 고치면서 새로 생긴 실패 모드다.
- 재현/확인: `audit.append`가 던지도록 바꾸고 `approve`를 부르면, 저장소에는 RUNNING/EXECUTING이 남고 `refunds.start`/`payments.executeBatch`는 호출되지 않는다. 시험에는 이 경로가 없다.
- 제안 수정: 상태 전이와 감사 기록을 **같은 트랜잭션**에 넣는다(`appendAuditIn` + store 갱신). 그것이 어려우면 감사 append 실패를 상태 전이 실패로 되돌리되, RUNNING/EXECUTING에서 재시도·복구할 수 있는 경로(예: `EXECUTING` 재개 작업, `RUNNING`인데 purchase에 요청이 없으면 JUDGED로 되돌리는 정비)를 둔다. 감사는 돈 이동을 막지 않게 outbox/재시도로 분리하는 편이 안전하다.
- 확신도: 높음

### [중간] OPSV-02: 지급 승인 Drizzle 저장소의 version 조건이 시험으로 보호되지 않는다(변이가 통과)
- 영역/배치: OPS-03/M4-08 수정, ops-svc payouts
- 위치:
  - `services/ops-svc/src/modules/payouts/adapters/db/drizzle-store.ts:69-84` — `where id = ... and version = r.version - 1`.
  - `services/ops-svc/test/payout-approval.test.ts:138-150` — OPS-03 시험은 `MemoryPayoutApprovalStore`(`:15`)를 쓴다.
  - `services/ops-svc/test-int/` — 지급 승인 통합 시험이 없다(파일 목록에 payout 없음).
- 증거: Drizzle 저장소의 `version` 조건을 제거하고 `payout-approval.test.ts`를 돌렸더니 **9/9 통과**했다. 메모리 저장소의 version 검사(`memory-store.ts:17-21`)가 시험을 통과시킨다. 회차 취소도 같은 구조다: `event-cancellations.test.ts`는 메모리 저장소를 쓰고, Drizzle 저장소의 version 조건은 Docker 통합 시험에서만 닿는데 그 시험에 동시 승인이 없다.
- 왜 문제인가: 운영 코드에서 version 조건이 사라져도 CI 초록이 유지된다. OPS-03의 핵심(동시 승인 시 DONE이 FAILED로 뒤집히지 않음)이 실제 DB에서 회귀해도 잡지 못한다.
- 재현/확인: 위 변이 표. Drizzle 조건 제거 → 9/9 통과.
- 제안 수정: 지급 승인·회차 취소 각각에 실제 PostgreSQL 저장소를 쓰는 통합 시험(동시 approve 2건)을 더한다. 또는 메모리 저장소 시험과 별도로 Drizzle `save`의 0행/1행 동작을 단위 시험한다.
- 확신도: 높음

### [중간] OPSV-03: 수기 포트원 일괄 지급 실행이 감사 체인에 남지 않는다
- 영역/배치: OPS-01 수정, ops-svc payouts
- 위치:
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:142-144` — `recordPortoneExecution`은 `this.d.payments.recordPortoneExecution(...)`만 부른다.
  - `services/ops-svc/src/modules/payouts/inbound/payouts.controller.ts:96-101` — `@Roles(['operator'])`, 실행자(principal)를 넘기지 않는다.
  - 계약: `docs/features/settlement.md:315` "포트원 일괄 지급 실행 | ops-svc 감사 로그 | 실행자, 시각, 일괄 지급 ID, 정산일".
- 증거: `recordPortoneExecution`에는 `#audit` 호출이 없다. `PayoutApprovals`의 감사는 요청·승인·실행(승인 뒤 executeBatch)·실패·재시도·반려뿐이다.
- 왜 문제인가: 운영자가 포트원 콘솔에서 일괄 지급을 실행하고 그 ID를 기록하는 경로가 감사에 남지 않는다. 되돌릴 수 없는 지급 실행의 행위자·시각·ID를 사후에 확인할 수 없다.
- 재현/확인: `POST /v1/ops/payout-batches/{batchId}/portone-execution` 성공 뒤 `audit_chain`에 그 batchId/approvalId 행이 없다(코드 대조).
- 제안 수정: 컨트롤러에서 `@CurrentPrincipal()`을 받아 `recordPortoneExecution(batchId, bulkPayoutId, actor)`로 넘기고, `PAYOUT_APPROVAL_PORTONE_EXECUTED`를 `#audit`에 남긴다.
- 확신도: 높음

### [중간] OPSV-04: 감사 체인에는 해시만 남고 payload는 저장되지 않아, 정지·재개·반려 사유를 읽을 수 없다
- 영역/배치: OPS-01 수정, ops-svc 감사·회차 취소
- 위치:
  - `services/ops-svc/migrations/0000_ops_command_audit.sql:49-57` — `audit_chain` 칸은 `seq, record_type, record_id, record_sha256, mac, leaf_salt, created_at`뿐이다.
  - `services/ops-svc/src/modules/audit/audit.ts:36,86-88` — payload는 해시 계산에만 쓰이고 INSERT에는 없다.
  - `event-cancellations.ts:119-130` — 반려 사유 `reason`을 레코드에 저장하지 않고 감사 payload로만 넘긴다. `:132-152` — 정지·재개 사유와 `pg`도 레코드에 없다. `EventCancellationRecord`에는 `reason`(요청 사유)·`judgementReason`·`fanNoticeReason`만 있다(`domain/event-cancellation.ts:19-37`).
  - 계약: `docs/features/transfer-refund.md:233` "모든 정지·재개가 사유와 함께 감사 로그", `:400` "판정, 사유, 미리보기 수치, 승인자, 진행률".
- 증거: `audit_chain` 행은 남지만, payload(정지 사유·pg·반려 사유·jobState 등)는 어느 표에도 저장되지 않는다. 해시만으로는 그 내용을 복원할 수 없다. 통합 시험도 `record_type`만 확인한다(`test-int/event-cancellations.int.test.ts:97-98`).
- 왜 문제인가: "감사 로그"가 사람이 읽는 기록이 아니라 검증 불가능한 해시 목록이 된다. 정지·재개 사유는 사후 분쟁·POL-038 검증의 핵심인데, 지금은 해시만 있고 원문이 없다. 해시를 재계산할 payload가 없으므로 변조 검증도 해당 행에 대해 사실상 불가능하다.
- 재현/확인: `POST …/pauses`에 사유를 넣고 `event_cancellation_request`와 `audit_chain`을 읽으면 사유가 어디에도 없다(코드·스키마 대조).
- 제안 수정: `audit_chain`에 `payload jsonb`(또는 별도 append-only `audit_record` 표)를 더해 해시 대상 payload를 함께 저장한다. 최소한 `event_cancellation_request`에 `pause_reason`·`resume_reason`·`reject_reason`·`last_pg`를 두고 감사 payload와 같은 값으로 채운다.
- 확신도: 높음

### [중간] OPSV-05: 회차 취소 재인증이 지급(payment) 배선에 묶여 있어, 결제 URL이 없으면 확정이 503이다
- 영역/배치: SEC-02 수정, ops-svc main 배선
- 위치:
  - `services/ops-svc/src/main.ts:65-72` — `payouts`는 `paymentUrl`이 있을 때만 만들고, `reauth`는 그 안에서만 만든다.
  - `services/ops-svc/src/main.ts:90` — `eventCancellations: { refunds, ...(payouts?.reauth ? { reauth: payouts.reauth } : {}) }`.
  - `event-cancellations.ts:92` — `reauth`가 없으면 503 `dependency-unavailable`.
  - `services/ops-svc/src/modules/payouts/adapters/jwks-approval-verifier.ts:18-24` — `factors.includes('passkey')`를 요구한다.
- 증거: `PEAKET_PURCHASE_GRPC_ADDR`(환불)와 `PEAKET_IDENTITY_JWKS_URL`(재인증)이 있어도 `PEAKET_PAYMENT_HTTP_URL`이 없으면 `payouts`가 undefined → `reauth`가 없어 회차 취소 확정이 503이다. 회차 취소는 payment-svc를 직접 부르지 않는다(구매 gRPC가 환불을 맡는다). 또 재사용한 검증기는 패스키를 요구하는데, `docs/api/openapi.yaml`의 `ReauthToken`과 `docs/features/transfer-refund.md`에는 패스키 필수가 적혀 있지 않다.
- 왜 문제인가: 회차 취소 기능만 켜려는 배포에서 결제 URL을 함께 넣지 않으면 2인 확정이 막힌다. 패스키를 등록하지 않은 operator/commander는 계약상 재인증을 통과해도 403이다. 기능 장애를 보안 강화로 오인하게 된다.
- 재현/확인: `PEAKET_PAYMENT_HTTP_URL`을 비우고 `PEAKET_PURCHASE_GRPC_ADDR`·`PEAKET_IDENTITY_JWKS_URL`만 준 뒤 `POST …/approvals` → 503. 코드 경로.
- 제안 수정: 재인증 검증기를 `payouts`와 분리해 `PEAKET_IDENTITY_JWKS_URL`만으로 만든다. 패스키 필수 여부는 `EventCancellationReauth` 어댑터에서 계약에 맞게 정하고, 계약·문서에 명시한다.
- 확신도: 높음(코드), 운영 배포 발생 가능성 중간

### [낮음] OPSV-06: M4-01 시험이 수·목·금 경계와 월·연 경계를 단언하지 않는다
- 영역/배치: M4-01, ops-svc payouts
- 위치: `services/ops-svc/test/payout-approval.test.ts:102-108`
- 증거: 시험은 월요일(→금요일), 화요일(→월요일), 토요일(→금요일), 일요일(→금요일)만 본다. 수·목·금 지급일, 월말·연말, 공휴일은 없다. 변이(`-1`→`-2`)는 화요일 단언에서 잡혔다.
- 왜 문제인가: 수·목·금에만 영향을 주는 회귀(예: 요일 표를 잘못 읽는 구현)는 통과한다. 공휴일은 코드가 아예 건너뛰지 않으므로 "영업일" 계약과 다르다.
- 제안 수정: 수·목·금, 3월 2일(월)→2월 27일(금), 2027-01-01(금)→2026-12-31(목)을 더한다. 공휴일 달력은 별도 후속으로 명시한다.
- 확신도: 높음

### [낮음] OPSV-07: OPS-04의 실제 DB 직렬화·원자성이 시험으로 확인되지 않는다
- 영역/배치: OPS-04, ops-svc audit
- 위치:
  - `services/ops-svc/src/modules/audit/checkpoint.ts:289-309` — 실제 `createWithAudit`.
  - `services/ops-svc/test/audit-anchor.test.ts:52-70` — 시험은 `MemoryAuditCheckpointStore`를 상속한 가짜 `AtomicStore`로 `createWithAudit`를 흉내 낸다.
  - `services/ops-svc/test-int/command-execution.int.test.ts:167` — 체크포인트 2건 존재만 확인하고 동시 생성은 확인하지 않는다.
- 증거: 실제 `DrizzleAuditCheckpointStore.createWithAudit`의 head 행 잠금을 제거하거나 두 트랜잭션으로 나눠도, 가짜 저장소를 쓰는 단위 시험은 통과한다. 통합 시험도 순차 실행뿐이다.
- 왜 문제인가: OPS-04의 핵심(같은 구간 중복 방지·체크포인트와 체인 기록의 원자성)이 실제 DB에서 회귀해도 잡지 못한다.
- 제안 수정: 실제 PostgreSQL에서 `Promise.all`로 `create` 2건을 동시에 호출해 체크포인트 1건·`AUDIT_CHECKPOINT_CREATED` 1건을 확인하는 통합 시험을 더한다. 감사 append가 실패하도록 만들어 체크포인트 행도 롤백되는지 확인한다.
- 확신도: 높음

### [낮음] OPSV-08: 감사·순서 시험이 일부 전이만 덮는다
- 영역/배치: OPS-01·OPS-07, ops-svc tests
- 위치:
  - `test/event-cancellations.test.ts:60` — 요청·판정·확정·시작만 단언한다. 반려·정지·재개 감사는 단언하지 않는다.
  - `test/payout-approval.test.ts:152-157` — 요청·승인·실행만 단언한다. `PAYOUT_APPROVAL_REJECTED`·`RETRIED`·`FAILED`는 단언하지 않는다.
  - `test/event-cancellations.test.ts:103-111` — 동시 확정은 200/409만 보고 `refunds.start` 호출 수·순서를 단언하지 않는다.
- 증거: `#audit` 호출을 전부 no-op으로 만들면 잡히지만, 반려·정지·재개·재시도·실패 호출만 지우면 위 시험들은 통과한다. 동시 확정 시험이 `refunds.start`를 저장 전에 부르도록 바꿔도(version 조건이 있으면) 200/409가 유지되어 통과한다.
- 왜 문제인가: OPS-01의 "모든 전이"와 OPS-07의 "외부 호출 전 저장"이 시험으로 고정되지 않는다.
- 제안 수정: 전이별 `record_type` 배열을 전부 단언하고, `refunds.start`가 불릴 때 저장소 상태가 RUNNING인지 확인하는 스파이를 둔다.
- 확신도: 높음

### [낮음] OPSV-09: 자동 정지(PAUSED)가 여전히 RUNNING으로 표시되고, DONE/FAILED 저장 결과를 무시한다
- 영역/배치: OPS-07·M4-05 잔여, ops-svc
- 위치:
  - `services/ops-svc/src/modules/event-cancellations/application/event-cancellations.ts:105` — `job.state === 'COMPLETED' ? … : job.state === 'REFUND_WINDOW' ? … : 'RUNNING'`. `PAUSED`가 RUNNING이 된다.
  - `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:110,115` — `save(done)`·`save(failed)`의 boolean 반환을 무시한다.
  - `event-cancellations.ts:136-138,147-149` — 정지·재개는 purchase 호출 **뒤에** 저장한다.
- 증거: 구매 쪽이 첫 묶음에서 자동 정지(`PAUSED`)를 내면 ops는 RUNNING으로 적는다. `save(done)`이 0행이어도 DONE 응답·EXECUTED 감사를 남긴다. 정지 저장이 version 충돌로 실패하면 purchase는 멈췄는데 ops는 RUNNING이다.
- 왜 문제인가: 운영자가 "진행 중"으로 보고 재개하지 않거나, 실제로는 실행 중인 지급을 실패로 본다.
- 제안 수정: `job.state`를 그대로 매핑하고(PAUSED→PAUSED), `save(done/failed)`가 false면 예외로 되돌린다. 정지·재개도 `PAUSING`/`RESUMING` 같은 중간 상태를 먼저 조건부 저장한 뒤 외부를 부른다.
- 확신도: 높음

---

## 통과로 확인한 것

- **OPS-01 배선**: `AppModule`이 `PayoutsModule`·`EventCancellationsModule`에 같은 `chain`을 넘긴다(`app.module.ts:54-55,72-73`). 두 모듈의 `#audit`가 `append`를 부른다. 회차 취소는 요청·판정·확정·시작·실패·반려·정지·재개 8곳, 지급은 요청·승인/재시도·실행·실패·반려 5곳이다.
- **OPS-01 실제 DB 확인**: `test-int/event-cancellations.int.test.ts:97-98`이 `select record_type from audit_chain where record_id = $1 order by seq`로 `REQUESTED, JUDGED, APPROVED, STARTED`를 단언한다. 메모리 체인 시험도 같은 배열을 본다.
- **M4-01 계산**: `approvalDueAt`은 지급일에서 하루씩 빼며 토·일을 건너뛰고, `T15:00:00+09:00`으로 만든다. 월요일→금요일, 화요일→월요일, 토·일→금요일이 맞다. `-2` 변이는 시험에서 잡혔다.
- **OPS-03 저장소**: Drizzle `save`에 `and version = r.version - 1`이 있고, 메모리 저장소도 같은 조건을 강제한다. `approve`는 `EXECUTING` 저장이 false면 409를 던진다.
- **OPS-04 실제 코드**: `createWithAudit`가 `select 1 from audit_chain_head where id = 1 for update` → 기존 `from_seq` 확인 → 삽입 → `appendAuditIn(tx, record)`를 한 트랜잭션에 한다. 실패하면 체크포인트 삽입도 롤백된다.
- **OPS-07 순서**: `save(running)`(version 조건) 성공 뒤에만 `refunds.start`를 부른다. 실패 시 `save(back)`으로 JUDGED를 시도한다.
- **SEC-02**: 컨트롤러가 `x-reauth-token`을 읽고(`event-cancellations.controller.ts:93-96`), `verify(token, {sessionId, act:'APPROVAL'})` 뒤 `verified.accountId !== actor.accountId`면 403이다. 토큰 없음·다른 계정·다른 act를 단위 시험이 확인한다.

## 남은 위험(요약)

1. **감사 append의 비원자성**(OPSV-01) — 가장 먼저 고칠 것. 돈 이동이 감사 실패에 걸리거나, 성공이 실패로 보고된다.
2. **운영 DB version 조건 미보호**(OPSV-02) — 변이로 확인된 시험 공백.
3. **수기 포트원 실행 감사 누락**(OPSV-03).
4. **감사 payload 미저장**(OPSV-04) — 사유·수치를 읽을 수 없다.
5. **재인증 배선이 payment URL에 의존**(OPSV-05) — 회차 취소만 켜는 배포에서 503.
6. 시험 공백: M4-01 수·목·금, OPS-04 실제 DB 경합, 감사 전이 전체, OPS-07 순서.
7. 공휴일 미반영, `PAUSED`→`RUNNING`, 정지·재개 외부 호출 후 저장.

## 작업 상태

- 내 변이 파일은 모두 `git checkout --`로 원복했다. `git diff --stat 1ae63462..HEAD -- services/ops-svc`는 **빈 출력**이다(내가 만진 ops-svc 변경 0건).
- 검증 중 **다른 작업자**가 같은 worktree의 `services/purchase-svc/**`를 수정하고 커밋했다. 현재 HEAD는 `4596b246`(R-598)이고, R-597(`1ae63462`)의 자식이다. R-598은 `services/purchase-svc/**`와 문서만 건드렸고 `services/ops-svc/**`는 건드리지 않았다.
- 검증 시작 시점의 `?? out/`은 R-598 커밋 뒤 사라졌다(다른 작업자의 정리). 나는 `out/`을 읽거나 쓰지 않았다.
- 최종 `git status --short`는 **깨끗하다**(출력 없음). 내가 커밋·푸시한 것은 없다.
