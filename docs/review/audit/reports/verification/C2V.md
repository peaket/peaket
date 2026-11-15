# C2V — R-600 수정 검증(독립)

- 대상: `D:\ticketpass-lane1` 커밋 `4768ff76`(R-600, `fix(identity): end staff assignments and scanner sessions on withdrawal and merge`)
- 기준 커밋 부모: `7460f556`
- 검증자: 웨이브 6 독립 감사 C2(구현 비참여). 코드 수정·커밋·푸시·Docker 금지. 변이만 잠시 넣고 원복했다.
- 결론: **조건부 통과**. C2-01의 탈퇴 경로와 C2-05의 불변식은 코드·단위 시험으로 확인했다. C2-01의 병합 경로는 코드는 있으나 **그 호출을 잡는 시험이 없고**, C2-05의 **부분 유일 인덱스 자체를 잡는 시험도 없다**(동시 승인 시험은 계정 행 잠금만으로 통과). 요구한 접근 차단(탈퇴·병합 계정의 `valid:false`)은 코드상 성립하고, 확인된 기능 결함은 없다. 다만 낮은 확률의 동시성 문제(교착·경합)와 정리 실패 시 잔여 데이터가 있어 아래에 적는다.
- 판정 요약:
  - C2-01 탈퇴: **통과**(M1 변이를 단위 시험이 잡음).
  - C2-01 병합: **코드 통과, 시험 결함**(M3 변이가 생존; C2V-01).
  - C2-05 불변식: **코드 통과, 시험 결함**(M4 인덱스 변이가 생존; C2V-02).

## 1. 확인한 수정 내용

### C2-01 탈퇴·병합

- `WithdrawAccount.run`은 `completeWithdrawal` 커밋 뒤 `staff.terminateByAccount({ accountId, reason: 'STAFF_REVOKED', nowMs: now })`를 부른다(`services/identity-svc/src/modules/session/application/withdraw-account.ts:84-92`). `staff`는 `@Optional() @Inject(STAFF_ASSIGNMENT_STORE)`이고, `session.module.ts:111`이 `DrizzleStaffAssignmentStore`(또는 메모리)를 제공하므로 운영에서 주입된다.
- `ConfirmMerge.run`은 병합 트랜잭션 커밋 뒤 흡수 계정에 대해 같은 호출을 한다(`.../confirm-merge.ts:116-123`). 실패는 경고 로그로 남기고 병합은 성공으로 둔다.
- `DrizzleStaffAssignmentStore.terminateByAccount`(`.../adapters/db/drizzle-staff-assignment-store.ts:281-306`)는
  - 그 계정의 살아 있는 `scanner_session`을 `FOR UPDATE`로 읽어 `terminated_at`을 채우고,
  - 그 계정의 `staff_assignment`를 `ASSIGNED`·`INVITED`에서 `REVOKED`로 바꾸고,
  - 세션마다 `control.sessions-terminated`(`reason: 'STAFF_REVOKED'`, `key: accountId`)를 같은 트랜잭션의 Outbox에 적는다.
- `CheckScannerSession.run`은 `findScannerSession`이 돌려준 `accountId`로 `accountStatusOf`를 보고 `!== 'ACTIVE'`면 `valid:false`다(`.../check-scanner-session.ts:16-22`). `WITHDRAWAL_PENDING`·`MERGED`·`DELETED`·계정 없음(null) 모두 false다.
- `findScannerSession`은 `staff_assignment.account_id`를 `accountId`로 싣고, 그 값이 NULL이면 null을 돌려준다(`.../drizzle-staff-assignment-store.ts:135-155`).
- 계약의 `SessionTerminated.reason`에 `STAFF_REVOKED`가 있다(`packages/contracts/src/gen/asyncapi/model/sessionTerminated.zod.ts:12`). `ACCOUNT_DELETED`·`ACCOUNT_MERGED`는 계약에 없어 쓰지 않았고, 탈퇴·병합 모두 `STAFF_REVOKED`를 쓴다(과제가 허용한 값).

### C2-05 계정당 스캐너 세션 하나

- `migrations/0033_scanner_session_account_unique.sql`:
  - `staff_account_id` 추가 → `staff_assignment.account_id`로 백필 → NULL 행 삭제 → 계정별 최신 `approved_at` 하나만 남기고 나머지 `terminated_at=now()` → `SET NOT NULL` → 부분 유일 인덱스 `scanner_session_account_active_key ON scanner_session (staff_account_id) WHERE terminated_at IS NULL`.
  - `migrations/meta/_journal.json`에 idx 33으로 등록됨.
- `schema.ts`의 `scannerSession.staffAccountId`(`notNull`)와 같은 이름·정의의 부분 유일 인덱스가 선언되어 마이그레이션과 일치한다(`.../adapters/db/schema.ts:280-300`).
- `createScannerSession`은 트랜잭션 첫 문장에서 `account` 행을 `FOR UPDATE`로 잠그고(`.../drizzle-staff-assignment-store.ts:195`), 그 계정의 살아 있는 세션을 `staffAccountId`·기기·배정으로 모두 끝낸 뒤 새 세션을 넣는다. `staff_account_id`도 함께 넣는다.
- 메모리 저장소도 `terminateByAccount`·`accountStatusOf`·`accountId`를 구현해 단위 시험이 같은 계약을 본다.

## 2. 실행한 시험

Docker가 금지라 test-int는 실행하지 못했다. 단위 시험은 `pnpm --filter @peaket/identity-svc exec vitest run <file>`로 돌렸다. 커밋 메시지의 "identity 단위 554·test-int 171"은 전체 시험·Docker 금지로 독립 확인하지 않았고, 아래 표적 시험만 직접 확인했다.

| 시점 | 명령/파일 | 결과 |
| --- | --- | --- |
| 기준선(작업 트리 clean) | `test/withdrawal.test.ts test/check-scanner-session.test.ts test/terminate-scanner-sessions.test.ts` | 3 files / **31 passed** |
| 추가 확인(다른 세션 변경이 나타나기 시작한 시점, R-600과 무관한 파일) | `test/merge.test.ts test/device-approval.test.ts test/staff-invitations.test.ts` | 3 files / **49 passed** |
| 변이 M1 | `withdraw-account.ts`의 `terminateByAccount` 호출 제거 → `test/withdrawal.test.ts` | **1 failed / 20 passed** (assignment `ASSIGNED` ≠ `REVOKED`) — 잡힘 |
| 변이 M2 | `check-scanner-session.ts`의 `accountStatusOf` 검사 제거 → `test/check-scanner-session.test.ts` | **1 failed / 7 passed** (`true` ≠ `false`) — 잡힘 |
| 변이 M3 | `confirm-merge.ts`의 `terminateByAccount` 호출 제거 → `test/merge.test.ts` | **33 passed** — **잡지 못함** |
| 변이 M4 | `0033` 유일 인덱스 제거 | **실행 불가**(Docker 금지). 아래 분석 참조 |

- M1·M2는 원복 후 `git status --short`에서 해당 파일이 사라진 것을 확인했다.
- M3도 원복했다. `merge.test.ts`는 `new ConfirmMerge(sessions, reauth, planner, proposals, k.clock)`로 staff 포트를 넘기지 않아, 병합 경로의 정리 호출을 관측할 수 없다(`test/merge.test.ts:42`).
- M4는 test-int가 `docker run`으로 PostgreSQL·Valkey를 띄우므로 실행하지 않았다(`test-int/postgres.ts:21`, `test-int/valkey.ts:14`). 정적 분석으로는 아래 C2V-02처럼 **인덱스를 지워도 동시 승인 시험이 통과**한다.

### test-int 코드가 실제로 단언하는지

`test-int/device-approval.int.test.ts`:
- `탈퇴·병합된 계정의 배정을 끝내고 세션 종료 사유를 남긴다`(`:157-175`): `store.terminateByAccount`를 직접 불러 `assignments: 1, sessions: 1`, `staff_assignment.status = REVOKED`, `scanner_session.terminated_at not null`, `outbox` payload `{accountId, sessionId, reason: 'STAFF_REVOKED'}`, `check.run(...).valid === false`를 단언한다. DELETED·MERGED 두 상태를 돈다.
- `같은 계정의 동시 승인은 한 세션만 남긴다`(`:148-155`): 같은 계정으로 `createScannerSession` 둘을 `Promise.all`로 부르고 살아 있는 세션 수 1을 단언한다.
- `0033` 적용 확인(`:143-145`): `scanner_session_account_active_key` 인덱스 존재를 단언한다.
- 한계: 두 시험 모두 **유스케이스(`WithdrawAccount`·`ConfirmMerge`)를 부르지 않고 저장소 메서드를 직접** 부른다. 따라서 "탈퇴·병합이 정리를 부른다"는 호출부는 test-int가 검증하지 않는다(탈퇴는 단위 시험이, 병합은 아무 시험도 검증하지 않는다).

## 3. 발견

### [중간] C2V-01: 병합 뒤 스태프 정리 호출을 잡는 시험이 없다(변이 M3 생존)

- 영역/배치: identity-svc 계정 병합(C2-01), `ConfirmMerge`
- 위치:
  - `services/identity-svc/src/modules/session/application/confirm-merge.ts:116-123` (정리 호출)
  - `services/identity-svc/test/merge.test.ts:42` (`ConfirmMerge`에 staff 포트를 넘기지 않는다)
  - `services/identity-svc/test-int/merge.int.test.ts:50,290,384` (통합 시험도 staff 포트 없이 `ConfirmMerge`를 만든다)
  - `services/identity-svc/test-int/device-approval.int.test.ts:157-175` (저장소 메서드만 직접 호출)
- 증거: `confirm-merge.ts`의 `terminateByAccount` 호출을 지우고 `test/merge.test.ts`를 돌렸더니 **33 passed**였다. 즉 병합 경로에서 정리 호출이 사라져도 CI 단위 시험은 초록이다. test-int `merge.int.test.ts`도 `ConfirmMerge`를 staff 포트 없이 만들어(5인자) 정리 호출을 관측하지 못한다.
- 왜 문제인가: C2-01의 절반(병합)이 회귀해도 시험이 잡지 못한다. 병합된 계정은 `CheckScannerSession`의 계정 상태 검사로 스캔은 막히지만, `staff_assignment`가 `ASSIGNED`로 남고 `STAFF_REVOKED` Outbox가 빠져 파트너·운영 화면과 종료 전파가 어긋난다.
- 재현/확인: 위 M3. `git checkout -- services/identity-svc/src/modules/session/application/confirm-merge.ts`로 원복.
- 제안 수정: `merge.test.ts`의 `ConfirmMerge`에 가짜 `StaffAssignmentStore`를 넘기고, 흡수 계정에 대해 `terminateByAccount({ reason: 'STAFF_REVOKED' })`가 불렸는지 단언한다. 가능하면 test-int에서 `ConfirmMerge`를 실제 Drizzle 저장소로 돌려 `outbox`·`REVOKED`·`terminated_at`까지 본다.
- 확신도: 높음

### [중간] C2V-02: C2-05 부분 유일 인덱스 자체를 잡는 시험이 없다(동시 승인 시험은 계정 행 잠금만으로 통과)

- 영역/배치: identity-svc 기기 승인(C2-05), `0033` 마이그레이션
- 위치:
  - `services/identity-svc/test-int/device-approval.int.test.ts:148-155` (동시 승인 시험)
  - `services/identity-svc/src/modules/session/adapters/db/drizzle-staff-assignment-store.ts:195` (계정 행 `FOR UPDATE`)
  - `services/identity-svc/migrations/0033_scanner_session_account_unique.sql:25-27` (부분 유일 인덱스)
- 증거: 동시 승인 시험은 같은 계정의 두 `createScannerSession`을 `Promise.all`로 부른다. 두 호출은 같은 `account` 행의 `FOR UPDATE`에서 직렬화되고, 뒤 호출이 앞 세션을 끝낸 뒤 새 세션을 넣는다. 따라서 **유일 인덱스가 없어도** 최종 살아 있는 세션 수는 1이고 시험은 통과한다. 인덱스를 지운 변이를 넣어도 이 시험은 실패하지 않는다(정적 분석; Docker 금지로 test-int 실행은 못 했다). 시험은 인덱스 **존재**만 `pg_indexes`로 확인하고, 인덱스가 실제로 두 활성 행을 거절하는지는 보지 않는다.
- 왜 문제인가: 인덱스는 계정 잠금을 우회하는 다른 쓰기 경로(마이그레이션·수동 복구·향후 코드)에 대한 DB 백스톱인데, 그 백스톱이 사라져도 CI가 초록이다. C2-05의 "DB에서도 지킨다"는 주장이 시험으로 뒷받침되지 않는다.
- 재현/확인: 코드·시험 대조. Docker가 허용되면 ① `0033`에서 인덱스 생성 줄만 제거한 DB에서 ② `createScannerSession`의 계정 잠금을 우회해 두 활성 행을 직접 INSERT하는 시험(또는 `createScannerSession`의 `FOR UPDATE`를 잠시 제거)으로 인덱스가 23505를 내는지 본다.
- 제안 수정: test-int에 **인덱스를 직접 겨루는** 시험을 더한다. 예: 같은 `staff_account_id`로 살아 있는 `scanner_session` 두 행을 직접 INSERT하고 두 번째가 unique violation인지 단언. 또는 `createScannerSession`의 계정 잠금을 끈 시험용 경로(또는 별도 SQL)로 인덱스만 남겨 두 번째 INSERT가 실패하는지 본다. 계정 잠금 시험과 인덱스 시험을 분리한다.
- 확신도: 높음(구조), 중간(실행 재현은 Docker 필요)

### [낮음] C2V-03: test-int '탈퇴·병합' 시험이 유스케이스가 아니라 저장소 메서드를 직접 부른다

- 영역/배치: identity-svc C2-01 시험
- 위치:
  - `services/identity-svc/test-int/device-approval.int.test.ts:157-175` (저장소 메서드 직접 호출)
  - `services/identity-svc/test-int/withdrawal.int.test.ts:48,147,173` (`WithdrawAccount`를 staff 포트 없이 4인자로 만든다)
  - `services/identity-svc/test-int/merge.int.test.ts:50,290,384` (`ConfirmMerge`를 staff 포트 없이 만든다)
- 증거: `store.terminateByAccount(...)`를 직접 부른다. `WithdrawAccount.run`·`ConfirmMerge.run`이 그 메서드를 부르는지는 test-int가 보지 않는다. 탈퇴는 `test/withdrawal.test.ts`가 메모리 저장소로 호출부를 보지만, 실제 Drizzle 저장소와 함께 도는 end-to-end 시험은 없다. 병합은 C2V-01대로 호출부 시험이 없다.
- 왜 문제인가: 저장소 메서드와 유스케이스 호출부가 따로 시험되어, 둘을 잇는 배선(모듈 주입·`@Optional` 누락·호출 순서)이 회귀해도 잡지 못한다.
- 재현/확인: 시험 코드 대조.
- 제안 수정: test-int에서 `WithdrawAccount`·`ConfirmMerge`를 실제 저장소로 한 번씩 돌려 계정 상태·배정·세션·Outbox를 함께 단언한다.
- 확신도: 높음

### [낮음] C2V-04: 정리가 계정 트랜잭션 밖의 best-effort라 실패·크래시 시 배정 REVOKED·Outbox가 빠진다

- 영역/배치: identity-svc C2-01, `WithdrawAccount`·`ConfirmMerge`
- 위치:
  - `.../withdraw-account.ts:84-92` (계정 트랜잭션 커밋 뒤 별도 호출, 실패는 로그만)
  - `.../confirm-merge.ts:116-123` (같음)
  - `.../finish-withdrawals.ts:38`, `.../purge-incomplete-signups.ts:39` (`completeWithdrawal`를 직접 불러 스태프 정리를 건너뛴다)
- 증거: 계정은 이미 `DELETED`/`MERGED`라 `CheckScannerSession`이 false를 돌려주므로 **접근은 막힌다**. 그러나 `staff_assignment`는 `ASSIGNED`로 남고 `scanner_session`은 살아 있으며 `STAFF_REVOKED` Outbox가 없다. 만 14세 미만 정리(`finish-withdrawals`)·미완성 가입 정리(`purge-incomplete-signups`)는 `completeWithdrawal`를 직접 불러 같은 정리를 아예 하지 않는다.
- 왜 문제인가: 보안(스캔 차단)은 계정 상태 검사가 지키지만, 데이터·감사·운영 화면이 어긋난다. 파트너의 스태프 목록·`hasStaffAssignment`가 지난 배정을 계속 보이고, 종료 전파가 없다. 재시도·정비 작업도 없다.
- 재현/확인: 코드 대조. `terminateByAccount`가 던지도록 바꾸면 `WithdrawAccount`는 경고만 남기고 204로 끝난다(단위 시험의 `failErase`와 같은 구조).
- 제안 수정: `completeWithdrawal`(또는 그 직후 같은 트랜잭션)로 정리를 옮기거나, 실패 시 재시도할 정비 작업(예: `staff-revoke-pending`)을 둔다. `finish-withdrawals`·`purge-incomplete-signups`에도 같은 정리를 붙인다.
- 확신도: 높음(코드), 낮음(영향도 — 접근은 이미 차단)

### [낮음] C2V-05: `terminateByAccount`와 `createScannerSession`의 잠금 순서가 반대라 교착이 가능하다

- 영역/배치: identity-svc C2-01·C2-05 동시성
- 위치:
  - `.../drizzle-staff-assignment-store.ts:195,244-255` (`createScannerSession`: `account` → `staff_assignment` → `scanner_session`)
  - `.../drizzle-staff-assignment-store.ts:281-300` (`terminateByAccount`: `scanner_session` → `staff_assignment`)
- 증거: 승인 트랜잭션이 `staff_assignment` 잠금을 쥔 채 `scanner_session` 행 갱신을 기다리고, 동시에 탈퇴·병합 정리 트랜잭션이 `scanner_session` 잠금을 쥔 채 `staff_assignment` 갱신을 기다리면 고리가 된다. PostgreSQL이 한쪽을 중단한다.
- 왜 문제인가: 드물지만, 중단된 쪽이 승인이면 500(재시도 가능), 정리면 경고만 남기고 배정·Outbox가 빠진다(C2V-04). 보안은 계정 상태 검사가 지킨다.
- 재현/확인: 코드 대조. 실제 교착 재현은 PostgreSQL 2세션과 Docker가 필요해 실행하지 않았다.
- 제안 수정: `terminateByAccount`도 첫 문장에서 `account` 행을 `FOR UPDATE`로 잠그거나, 두 경로 모두 `staff_assignment` → `scanner_session` 순서로 통일한다.
- 확신도: 중간(교착 가능성), 낮음(빈도)

### [낮음] C2V-06: `createScannerSession`이 계정 상태를 확인하지 않아 탈퇴·병합과 경합한 승인이 REVOKED 배정·DELETED 계정에 활성 세션을 만들 수 있다

- 영역/배치: identity-svc C2-05
- 위치: `.../drizzle-staff-assignment-store.ts:195` (계정 행은 잠그지만 `status`를 읽지 않는다), `.../device-approvals.ts:114-156` (배정·세션 생성)
- 증거: 승인 트랜잭션이 계정 행 잠금을 기다리는 사이 탈퇴가 커밋되면, 승인은 잠금을 얻은 뒤 `staff_assignment`가 `REVOKED`가 되었는지·계정이 `ACTIVE`인지 다시 보지 않고 세션을 넣는다. 탈퇴 쪽 `terminateByAccount`가 그 뒤에 돌면 정리되지만, 먼저 끝나면 살아 있는 세션이 남는다. `CheckScannerSession`은 계정 상태·배정 상태로 false를 돌려주므로 **사용은 불가**하다.
- 왜 문제인가: 사용할 수 없는 활성 행이 남아 `scanner_session_account_active_key`를 점유하고, 감사·운영 화면에 유령 세션이 보인다. 접근 권한은 깨지지 않는다.
- 재현/확인: 코드 대조. 동시성 재현은 Docker 필요.
- 제안 수정: 계정 잠금 쿼리에서 `status`를 함께 읽어 `ACTIVE`가 아니면 거절하고, `staff_assignment`도 `status='ASSIGNED'`·유효 시간을 잠금 안에서 다시 본다.
- 확신도: 중간

### [낮음] C2V-07: 마이그레이션의 dedupe가 세션을 끝내면서 `control.sessions-terminated`를 남기지 않는다

- 영역/배치: `0033` 마이그레이션
- 위치: `migrations/0033_scanner_session_account_unique.sql:13-21`
- 증거: 기존 데이터 정리에서 계정당 최신 하나만 남기고 나머지를 `terminated_at=now()`로 끝내지만 Outbox를 쓰지 않는다. 스캐너 가드는 요청마다 `terminated_at`을 보므로 **스캔은 막힌다**. 다만 다른 서비스의 종료 세션 목록에는 그 세션 ID가 들어가지 않는다.
- 왜 문제인가: 마이그레이션 시점의 종료는 런타임 종료 사건과 달리 전파되지 않는다. 스캐너 경로는 DB 확인으로 안전하지만, "종료 사건을 남긴다"는 불변식과 문서가 어긋난다.
- 재현/확인: SQL 대조.
- 제안 수정: 마이그레이션에서 정리한 세션 ID를 임시 표에 모아 Outbox에 넣거나, 정리 결과를 문서에 "사건 없음(스캐너 가드가 DB로 확인)"으로 명시한다.
- 확신도: 높음

## 4. 통과로 본 항목

- **탈퇴 경로**: `WithdrawAccount`가 계정 파기 커밋 뒤 `terminateByAccount`를 부르고, 단위 시험이 배정 `REVOKED`·세션 `terminatedAt`·`terminatedEvents`(`STAFF_REVOKED`)를 단언한다. M1 변이를 잡는다.
- **계정 상태 검사**: `CheckScannerSession`이 `accountStatusOf !== 'ACTIVE'`면 false. DELETED·MERGED·ACTIVE를 단위 시험이 단언한다. M2 변이를 잡는다.
- **병합 코드**: `ConfirmMerge`가 흡수 계정에 `terminateByAccount`를 부르고, 계정은 이미 `MERGED`라 `CheckScannerSession` false. 호출 자체는 코드상 맞다(시험 공백은 C2V-01).
- **Outbox**: `terminateByAccount`가 세션마다 `control.sessions-terminated`(`STAFF_REVOKED`)를 같은 트랜잭션에 적는다. test-int가 `outbox` payload를 단언한다. 계약 enum에 `STAFF_REVOKED`가 있다.
- **0033 SQL**: 백필·NULL 삭제·계정별 dedupe·`SET NOT NULL`·부분 유일 인덱스 순서가 맞고, `_journal.json`에 등록됐다. `schema.ts`와 이름·정의가 일치한다.
- **동시 승인 불변식**: `createScannerSession`의 계정 행 `FOR UPDATE`가 같은 계정의 승인을 직렬화하고, `staffAccountId`·기기·배정으로 이전 세션을 끝낸 뒤 넣는다. test-int가 살아 있는 세션 수 1을 단언한다.
- **메모리 저장소**: `accountStatusOf`·`terminateByAccount`·`accountId`가 계약과 맞고, 단위 시험이 쓴다.

## 5. 작업 트리 상태(중요)

- 내 변이 3건(`withdraw-account.ts`, `check-scanner-session.ts`, `confirm-merge.ts`)은 모두 `git checkout --`로 원복했고, `git diff --name-only`에 그 세 파일이 없다.
- 그러나 검증 도중 **다른 세션의 미커밋 변경**이 같은 worktree에 나타났다: `packages/platform/src/auth.ts`·`service.ts`·`openapi.ts`, `staff-invitations.ts`, `staff.ts`, `staff-invitation.controller.ts`, `drizzle/memory-session-store.ts`(리프레시 `refreshUsed`), `verification-staff-phone.ts`, `test/admin-token-refresh.test.ts`, `test/staff-invitations.test.ts`, `test-int/staff-invitations.int.test.ts`, `docs/api/openapi.yaml`, `packages/platform/test/internal-token.test.ts`(신규) 등. 내용은 C2-02(휴대폰 본인확인)·C2-03(내부 토큰)·C2-04(리프레시 재시도) 작업으로 보인다.
- 나는 그 변경을 **건드리지 않았다**. 따라서 `git status --short`는 내 변이와 무관하게 깨끗하지 않다. 내가 만진 세 파일은 HEAD와 같다. 슈퍼바이저가 그 세션과 worktree를 분리해야 한다.
- 검증 시점: 기준선·M1·M2는 그 변경이 나타나기 전(작업 트리 clean)에 돌렸고, M3는 그 변경이 있는 상태에서 돌렸지만 `merge.test.ts`와 무관한 파일들이다.

## 6. 남은 위험·후속

1. **Docker 금지로 test-int를 실행하지 못했다.** C2-05 인덱스·동시 승인, C2-01의 실제 PostgreSQL Outbox는 정적 대조만 했다. Docker가 허용된 한 명이 `device-approval.int.test.ts`를 돌려 확인해야 한다.
2. **병합 호출부 시험**(C2V-01)과 **인덱스 자체 시험**(C2V-02)이 없다. 두 변이는 현재 CI에서 생존한다.
3. **정리 실패·크래시·under-14 정리**에서 배정·세션·Outbox가 남는다(C2V-04). 접근은 계정 상태 검사로 막히지만 데이터·감사가 어긋난다.
4. **잠금 순서 교착**(C2V-05)과 **승인 경합 시 유령 세션**(C2V-06)은 드물고 보안 영향은 낮지만, 계정 잠금에서 `status`를 확인하고 잠금 순서를 통일하면 함께 줄어든다.
5. **마이그레이션 dedupe의 종료 사건 부재**(C2V-07)는 스캐너 가드가 DB로 확인해 보안 영향은 없으나, 문서·계약의 "종료 사건" 기대와 다르다.
