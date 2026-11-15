# CONSV — R-599 수정 독립 검증 (CONS-01·CONS-02)

- 검증 대상: `D:\ticketpass-fix-payment`의 커밋 `e24ee8f8` (R-599, `fix(payment): 정산서 중복과 승인·지급 금액 불일치를 막는다`)
- 작업 위치: `D:\ticketpass-fix-payment`만. 메인 `D:\ticketpass`·소유자 파일 접근 없음. 수정·커밋·푸시·Docker 없음.
- 검증 방식: 커밋 diff·마이그레이션·계약·시험 정적 대조 + 표적 단위 시험 + 변이 6종(원복·해시 확인).
- **중요 환경 경고**: 이 worktree는 검증 시작 시점부터 **깨끗하지 않았다**. 다른 에이전트의 미커밋 작업(정산 due 스케줄러·A2-05/A2-06·payout 감사 체인 등)이 올라와 있었고, 검증 중에도 파일이 계속 늘었다(10:52 10건 → 11:03 25건). 나는 그 작업을 건드리지 않았고, 내 변이 편집은 모두 원복해 SHA-256이 기준값과 일치함을 확인했다(§6). 따라서 `git status --short`는 깨끗하지 않지만 **그 오염은 내 것이 아니다**.

---

## 0. 결론 요약

| 항목 | 판정 |
| --- | --- |
| CONS-01 회차·상품 부분 유일 인덱스 | **통과** — 인덱스 2개가 실제로 중복 삽입을 23505로 막고 SUPERSEDED를 허용한다. |
| CONS-01 `insertStatement`가 삽입 여부 반환 | **통과(코드)** — `onConflictDoNothing().returning()`으로 boolean. 단, Drizzle 쪽 충돌 경로 시험은 **비어 있다**(CONS-V01). |
| CONS-01 `calculateEvent` 기존 반환 / `calculateProduct` 건너뜀 | **통과** — 단위 시험 2건이 실제 경쟁을 재현하며, 메모리 저장소 충돌 검사를 끄는 변이에서 **둘 다 실패**했다. |
| CONS-02 `payout_batch_id` + 한 트랜잭션 결속 | **통과** — 배치 insert와 정산서 UPDATE가 한 트랜잭션, 조건 불일치 시 롤백·409. |
| CONS-02 `executeBatch`가 그 배치 정산서만 + 합계 409 | **통과** — `listConfirmed` 재조회 복원 변이에서 시험이 실패, 합계 검사 제거 변이에서도 실패. |
| CONS-02 승인 뒤 새 CONFIRMED 차단 | **통과** — `listConfirmed`가 미결속만, 실행은 `listStatementsByBatch`만. |
| `settlement.int.test.ts` 실제 PostgreSQL 단언 | **정적 확인만** — Docker 금지로 실행하지 못했다. 단언 내용은 요구와 일치하나, 중복 시험은 원시 SQL이라 `calculateEvent` 경쟁을 재현하지 않는다. |
| 남은 위험 | CONS-03(건별 지급 결과) **미해결**, 묶음 반려 시 정산서 고착(CONS-V02), `pg_store` 이중 정산(CONS-V03). |

**발견: 높음 0, 중간 3, 낮음 4.** (요청된 CONS-01·02 자체는 고쳐졌고, 아래는 잔여 위험·시험 빈칸이다.)

---

## 1. CONS-01 검증

### 1.1 인덱스 (`migrations/0017_settlement_guards.sql`)

```sql
CREATE UNIQUE INDEX "settlement_statement_event_key" ON "settlement_statement"
  ("promoter_id","event_id","pg","pg_store")
  WHERE "kind" = 'EVENT' and "status" <> 'SUPERSEDED';
CREATE UNIQUE INDEX "settlement_statement_product_key" ON "settlement_statement"
  ("promoter_id","pg","pg_store","period_start","period_end")
  WHERE "kind" = 'PRODUCT' and "status" <> 'SUPERSEDED';
```

- 두 인덱스 모두 **부분 유일**이고, `SUPERSEDED`만 제외한다. `settlement_statement`의 기존 `status` 값(CALCULATED…PAID)은 모두 인덱스에 포함되므로 상태가 바뀌어도 중복이 생기지 않는다.
- `event_id`(EVENT)·`period_start/period_end`(PRODUCT)는 각 생성 함수가 항상 채운다(`calculateEventStatement:eventId`, `calculateProductStatement:periodStart/End`). NULL로 인해 유일성이 무력화되는 경로는 없다.
- `payout_batch_id` 컬럼 + FK(`payout_batch`) + `settlement_statement_batch_idx`도 같은 마이그레이션에 있다.
- Drizzle `schema.ts`의 인덱스 정의와 스냅샷(`meta/0017_snapshot.json`)이 일치한다(`settlement-migration.test.ts`가 확인, 통과).
- 주의(낮음): 기존 DB에 이미 중복 정산서가 있으면 `CREATE UNIQUE INDEX`가 실패해 마이그레이션이 멈춘다. fail-fast로는 옳지만, 배포 전 중복 0건 확인이 필요하다(CONS-V06).

### 1.2 `insertStatement`

`drizzle-settlement-store.ts:103-141`:
- `insert ... .onConflictDoNothing().returning({ id })` → 0행이면 `false`, 1행이면 원본 목록까지 쓰고 `true`.
- 충돌 시 **원본 목록(statement_source)을 쓰지 않는다** — 부분 삽입 없음.
- `onConflictDoNothing()`은 대상 없는 형태라 PK 충돌까지 포함하지만, `statementId`는 uuidv7이라 실제 충돌은 두 부분 유일 인덱스뿐이다.
- 메모리 저장소(`memory-settlement-store.ts:27-39`)도 같은 키 규칙(kind/promoter/pg/store/event 또는 period, SUPERSEDED 제외)으로 `false`를 돌려준다. PG와 의미가 일치한다.

### 1.3 유스케이스

- `calculateEvent`(`settlements.ts:111-117`): `inserted === false`이면 `findEventStatement`로 **기존 정산서를 다시 읽어 반환**한다. 재조회도 실패하면 409 `settlement-statement-conflict`(정합 방어).
- `calculateProduct`(`:150-152`): `inserted === false`이면 그 그룹을 `continue`(건너뜀). `created`에도 세지 않는다. 기존의 "이미 있으면 continue"와 같은 의미다.
- 경쟁 창 분석: 두 트랜잭션이 같은 키를 넣으면 PostgreSQL이 인덱스 삽입에서 한쪽을 블록하고, 앞이 커밋하면 뒤는 `DO NOTHING` 0행, 앞이 롤백하면 뒤가 성공한다. 뒤의 재조회는 앞의 커밋 뒤라 반드시 보인다. **정합적으로 옳다.**

### 1.4 시험

- 단위 `test/settlement.test.ts`:
  - `CONS-01 같은 회차를 동시에 계산해도 정산서와 원본 목록은 한 장만 남는다` — `Promise.all` 두 호출, `statementId` 동일·`statements.size=1`·`sources.size=1` 단언.
  - 상품 경쟁은 `J-T18 상품 정산서는 …` 시험 안에 추가됨 — `Promise.all` 두 호출, `created` 합 1·`statements.size=1`.
  - **두 시험 모두 실제 경쟁을 재현한다**: 메모리 저장소의 `if (conflicts) return false;`를 `if (conflicts && false)`로 무력화하니 **두 시험이 함께 실패**했다(§5 M1). 즉 "기존 조회에서 걸러진 것"이 아니라 "둘 다 조회를 통과한 뒤 삽입 충돌"을 실제로 지나간다.
- 통합 `test-int/settlement.int.test.ts`:
  - `0017 부분 유일 인덱스가 … 23505로 막고 SUPERSEDED는 허용한다` — 원시 SQL로 같은 (promoter,event)를 두 번 insert해 23505, SUPERSEDED는 허용, 활성 1건, 인덱스·컬럼 존재를 단언. **의도대로 단언한다.**
  - 단, 이 시험은 `calculateEvent`/`insertStatement`를 두 번 부르지 않는다. 즉 **Drizzle 충돌 경로(§1.2)는 실제 PG로 시험되지 않는다**(CONS-V01).
- 실행 제약: 이 통합 시험은 `test-int/postgres.ts`가 `docker run postgres:18-alpine`으로 컨테이너를 띄운다. **Docker 금지 지침에 따라 실행하지 않았다.** 위 단언은 코드 정독으로 확인했다.

---

## 2. CONS-02 검증

### 2.1 결속 컬럼과 트랜잭션

- `settlement_statement.payout_batch_id`(nullable, FK→`payout_batch`) 추가. `StatementRecord`/`StatementView`/`statementView`/`statementRecord`/`saveStatement` 모두 반영. `calculate*Statement`는 `null`로 시작.
- `createPayoutBatchWithStatements(record, statementIds)`(`drizzle-settlement-store.ts:255-290`):
  - 한 트랜잭션에서 `payout_batch` insert → `settlement_statement` UPDATE(`payoutBatchId=:batch, status='SCHEDULED'`) `where id in (...) and status='CONFIRMED' and payout_batch_id is null`.
  - 갱신 행 수 ≠ 요청 수면 `payout-batch-statement-conflict` 409로 **롤백**(배치도 남지 않음).
  - 23505는 `payout-batch-exists` 409로 매핑(`uniqueViolation`이 `code`/`cause.code` 둘 다 봄).
  - 메모리 저장소도 같은 순서(전건 검증 → 배치 저장 → 결속)로 원자 흉내를 낸다.
- `createPayoutBatch`는 상계(`saveStatement`) 후 `createPayoutBatchWithStatements(batch, includedAfterOffset.map(...))`를 부른다(`settlements.ts:348`).

### 2.2 실행

`executeBatch`(`settlements.ts:366-...`):
- `listStatementsByBatch(batchId)`만 읽는다(재조회 없음).
- 0건이면 409 `payout-batch-empty`.
- `sum(payoutAmount) !== b.totalAmount`이면 409 `payout-batch-amount-mismatch` (게이트웨이 호출 **전**).
- 지급 건은 `boundStatements`로만 만든다.
- `listConfirmed`는 `payout_batch_id is null`만 돌려주므로 승인 뒤 새로 `CONFIRMED`된 정산서는 실행에 끼지 않는다.
- `saveStatement` 호출은 모두 기존 레코드 spread라 `payoutBatchId`가 보존된다(확인: `:253`, `:319`, `:404`).

### 2.3 시험

- 단위: `CONS-02 승인 뒤 새로 확정된 정산서는 실행에 끼지 않고…`(지급 건 = 묶인 것만, 새 정산서는 CONFIRMED 유지), `…합계가 … 다르면 409…`(409 + 지급 건 0), `…두 요청이 동시에 배치를 만들면 한쪽만 성공`.
- 통합(정적): 같은 세 가지 + `payout_batch_id`/`status`를 DB에서 직접 확인, 동시 생성은 `Promise.allSettled`로 실제 두 연결 경쟁, 성공 1·실패 409·배치 1행·결속 2건 단언.
- 실행 결과: 단위 3건 모두 통과. 통합은 Docker 금지로 미실행.

---

## 3. 실행한 시험 (표적)

| 명령 | 결과 |
| --- | --- |
| `pnpm --filter @peaket/payment-svc exec vitest run test/settlement.test.ts` | **16 passed** (R-599 CONS 4건 포함, 다른 에이전트가 추가한 A2-05/A2-06 포함) |
| `pnpm --filter @peaket/payment-svc exec vitest run test/payment-schema.test.ts test/settlement-migration.test.ts` | **76 passed** (0017 저널·스냅샷·SQL 단언 포함) |
| `… vitest run test/settlement.test.ts -t CONS-01` (변이 M1) | **1 failed** (의도) |
| `… vitest run test/settlement.test.ts` (변이 M1, 상품 포함) | **2 failed** (CONS-01 + J-T18 상품 경쟁) |
| `… vitest run test/settlement.test.ts -t CONS-02` (변이 M3) | **1 failed** (의도) |
| `… vitest run test/settlement.test.ts -t CONS-02` (변이 M4) | **1 failed** (의도) |
| `… vitest run test/settlement.test.ts` (변이 M2/M5/M6) | **16 passed** (생존 = 시험 빈칸) |
| `settlement.int.test.ts` | **미실행** — `docker run` 필요, Docker 금지 |

---

## 4. 변이 표

| # | 변이 | 위치 | 결과 | 해석 |
| --- | --- | --- | --- | --- |
| M1 | 메모리 `if (conflicts) return false;` → `&& false` | `memory-settlement-store.ts:35` | **사망** (CONS-01 2건 실패) | 동시 계산 시험이 실제 충돌 경로를 지난다. |
| M2 | 메모리 결속 검사에서 `payoutBatchId !== null` 제거 | `memory-settlement-store.ts:84` | **생존** (16 passed) | "이미 묶인 정산서를 다른 묶음에 결속" 시험이 없다. 단, `status='CONFIRMED'` 가드가 실질 방어라 영향 낮음(CONS-V04). |
| M3 | `executeBatch`의 `const statements = boundStatements;` → `listConfirmed(...)` 재조회 복원 | `settlements.ts:380` | **사망** (CONS-02 승인 밖 지급 시험 실패) | CONS-02 회귀를 시험이 잡는다. |
| M4 | 합계 검사 `if (boundTotal !== b.totalAmount)` → `&& false` | `settlements.ts:377` | **사망** (409 단언 실패, 503으로 진행) | 합계 검사 회귀를 시험이 잡는다. |
| M5 | Drizzle `.onConflictDoNothing()` 제거 | `drizzle-settlement-store.ts:135` | **생존** (22 passed) | **Drizzle 충돌 경로 시험 없음**(CONS-V01). 실제 경쟁 시 23505가 500으로 샌다(데이터 중복은 인덱스가 막음). |
| M6 | Drizzle 결속 UPDATE에서 `isNull(payoutBatchId)` 제거 | `drizzle-settlement-store.ts:280` | **생존** (16 passed) | defense-in-depth 미시험. `status='CONFIRMED'` 가드가 실질 방어(CONS-V04). |

모든 변이는 실행 후 원복했고, 대상 3파일의 SHA-256이 기준값과 일치한다(§6).

---

## 5. 발견

### [중간] CONS-V01: Drizzle `insertStatement`의 충돌 경로가 어떤 시험에도 걸리지 않는다
- 영역/배치: 결제/정산 (R-599 CONS-01)
- 위치: `services/payment-svc/src/modules/settlement/adapters/db/drizzle-settlement-store.ts:103-141`, `test-int/settlement.int.test.ts:180-200`
- 증거: `.onConflictDoNothing()`을 제거하는 변이 M5가 **모든 실행 가능 시험(22건)을 통과**했다. 단위 시험은 메모리 저장소만 쓰고, 통합 시험의 중복 시험은 원시 SQL insert라 `insertStatement`를 부르지 않는다. `calculateEvent`를 두 번 동시에 부르는 통합 시험은 없다.
- 왜 문제인가: 실제 경쟁에서 `onConflictDoNothing`이 빠지면 두 번째 호출이 23505를 그대로 던져 `guard`가 매핑하지 못하고 **500**이 된다(중복 데이터는 인덱스가 막으므로 정합은 유지). 고위험 경로(정산서 생성)의 DB-side 반환값이 시험으로 고정되지 않았다는 것이 핵심이다.
- 재현/확인: M5 변이 → `vitest run test/settlement.test.ts test/settlement-migration.test.ts` → 22 passed.
- 제안 수정: 통합 시험에 `Promise.all([settlements.calculateEvent(...), settlements.calculateEvent(...)])`를 더해 **같은 statementId 1건**과 `insertStatement` 재호출 false를 실제 PG로 단언한다. 또는 `DrizzleSettlementStore.insertStatement`를 직접 두 번 불러 두 번째가 false인지 본다.
- 확신도: 높음.

### [중간] CONS-V02: 지급 묶음을 반려·방치하면 그 정산서가 영구히 묶여 같은 지급일의 지급이 막힌다
- 영역/배치: 결제/지급 (R-599 CONS-02가 만든 새 위험)
- 위치: `services/payment-svc/src/modules/settlement/application/settlements.ts:348`(생성 시 결속), `services/ops-svc/src/modules/payouts/application/payout-approvals.ts:114-125`(반려), `0015_settlement.sql`의 `payout_batch_key`
- 증거:
  - 결속은 **승인 시점이 아니라 생성 시점**(`PENDING_APPROVAL`)에 일어난다. 커밋 메시지·주석의 "승인 시점에 묶여"와 다르다.
  - `PayoutApprovals.reject`는 ops 승인 레코드만 `REJECTED`로 바꾸고 payment-svc에 아무것도 부르지 않는다(감사 로그 append만 추가됨). payment-svc에는 배치 취소·정산서 해제(unbind) 경로가 없다(`payout_batch_id`를 NULL로 되돌리는 코드 0건).
  - 그 상태에서 `listConfirmed`는 `payout_batch_id is null`만 주므로 그 정산서는 다시 후보가 되지 못하고, `payout_batch_key`(pg,pg_store,payout_date where status not in COMPLETED/PARTIAL_FAILED)가 같은 날짜의 새 묶음도 막는다. `executeBatch`는 `APPROVED`만 받으므로 반려된 묶음은 실행도 불가.
  - 결과: 그 지급일의 지급이 **수동 SQL 없이는 영구히 불가**.
- 왜 문제인가: 운영자가 실수로 반려하거나 승인하지 않고 방치하면 파트너 지급이 멈추고, 정산서가 화면에서 사라져 원인 파악도 어렵다. 돈이 잘못 나가지는 않지만 복구가 수동이다.
- 재현/확인: 코드 대조. `reject` → payment-svc 호출 0건, unbind 0건.
- 제안 수정: ① 반려 시 payment-svc에 `releasePayoutBatch(batchId)`(배치 `CANCELED`/삭제 + 정산서 `payout_batch_id=NULL`, `status='CONFIRMED'` 복원)를 호출한다. ② 또는 결속을 승인(`approveBatch`) 트랜잭션으로 옮기고, 생성 시에는 후보 목록만 스냅샷으로 남긴다. ③ 최소한 배치 만료(예: 승인 기한) 스윕으로 자동 해제한다.
- 확신도: 높음.

### [중간] CONS-V03: 같은 회차·PG를 STANDARD와 ESCROW로 각각 정산하면 같은 결제가 두 정산서에 계상된다(유일 인덱스가 막지 못함)
- 영역/배치: 결제/정산 (CONS-01 잔여)
- 위치: `settlements.ts:92-113`(`pgStore`는 입력값), `drizzle-payment-source.ts:20-33`(결제 조회에 store 조건 없음), `0017_settlement_guards.sql`의 event 인덱스가 `pg_store`를 키에 포함
- 증거: `calculateEvent({promoterId,eventId,pg,pgStore})`는 `listEventPayments(eventId,pg)`로 결제를 읽고 `pg_store`는 인자만 저장한다. 따라서 `pgStore='STANDARD'`와 `'ESCROW'`로 두 번 부르면 **같은 결제 집합**을 가진 정산서 2장이 만들어지고, 새 유일 인덱스는 `pg_store`가 달라 둘 다 허용한다. `listConfirmed`/`createPayoutBatch`도 store별로 따로 움직여 둘 다 지급될 수 있다. 불변식 M4는 `REFUND` 원천만, M5는 정산서 **내부** 정합만 보므로 이 중복을 잡지 않는다.
- 왜 문제인가: `pg_store`는 결제 데이터와 연결되어 있지 않아( payment 표에 store 칸 없음) 운영자가 잘못 고르면 같은 매출을 두 번 지급한다. CONS-01의 "같은 매출 이중 지급"이 키만 바꾸면 재현된다.
- 재현/확인: 코드 대조. `pg_store`를 검증하는 계약·표·조건 0건.
- 제안 수정: ① 결제 원천에 store를 싣고(계약/스키마) 정산서의 `pg_store`를 그 값에서 유도한다. ② 또는 회차 인덱스 키에서 `pg_store`를 빼고 `(promoter_id,event_id,pg)`로 "회차·PG당 정산서 1장"을 강제한다(에스크로/일반이 한 회차에 섞이지 않는다는 전제 확인 필요). ③ 불변식에 "한 결제의 GROSS 원천이 비SUPERSEDED 정산서 2장에 없다"를 추가한다.
- 확신도: 높음(코드), 발생은 운영자 선택 오류·중복 호출에 의존(중간).

### [낮음] CONS-V04: `payout_batch_id` 결속 조건 제거 변이가 살아남는다
- 위치: `drizzle-settlement-store.ts:280`, `memory-settlement-store.ts:84`
- 증거: M2·M6 생존. "이미 묶인 정산서를 다른 묶음에 결속" 시험이 없다.
- 왜 문제인가: 지금은 `status='CONFIRMED'` 가드가 실질 방어라 사고로 이어지지 않지만, 상태 기계가 바뀌면(예: 결속 후에도 CONFIRMED 유지) 조용히 이중 결속될 수 있다.
- 제안 수정: 두 번째 배치가 같은 정산서를 결속하려 하면 409 `payout-batch-statement-conflict`인지 단위·통합에 한 줄 추가.
- 확신도: 높음.

### [낮음] CONS-V05: `payoutBatchId`가 파트너 응답에 실리지만 OpenAPI·생성 계약에 없다
- 위치: `domain/settlement.ts:181,207`(`StatementView`), `packages/contracts/src/gen/openapi/model/settlementStatement.zod.ts`(필드 없음)
- 증거: `statementView`가 `payoutBatchId`를 항상 싣고, 파트너 정산 목록도 같은 뷰를 쓴다. 생성 계약·openapi에는 칸이 없고, 응답 검증은 `.passthrough()`/zod strip이라 통과한다.
- 왜 문제인가: 계약과 실제 응답이 어긋나고, 내부 지급 묶음 ID가 파트너에게 노출된다(민감도는 낮음). 계약 커버리지 감사에서 잡힐 유형이다.
- 제안 수정: `payoutBatchId`를 내부 뷰에만 두고 파트너 응답에서 빼거나, openapi·생성물을 갱신한다.
- 확신도: 높음.

### [낮음] CONS-V06: 0017은 기존 중복이 있으면 마이그레이션 중단, 파일 끝 개행 없음
- 위치: `migrations/0017_settlement_guards.sql`
- 증거: `CREATE UNIQUE INDEX`(비 CONCURRENTLY) 2건. 파일 마지막 바이트가 개행이 아니다(`\ No newline at end of file`).
- 왜 문제인가: 중복이 있는 환경에서는 배포가 멈춘다(데이터를 지키는 fail-fast로는 옳다). 대형 테이블이면 인덱스 생성 동안 쓰기 잠금이 길어진다. 개행은 스타일.
- 제안 수정: 배포 전 `select ... group by ... having count(*)>1` 점검 절차를 릴리스 노트에 넣고, 필요하면 `-- peaket:no-transaction` + `CONCURRENTLY`로 바꾼다. 파일 끝 개행 추가.
- 확신도: 높음.

### [낮음] CONS-V07: 미수금 상계가 배치 트랜잭션 밖이라 배치 생성 실패 시 상계만 남는다
- 위치: `settlements.ts:314-327`(상계 루프), `:348`(배치 결속)
- 증거: 상계는 `saveReceivable`/`insertReceivableMove`/`saveStatement`를 각각 커밋하고, 그 뒤에 `createPayoutBatchWithStatements`가 별도 트랜잭션으로 돈다. 배치 insert가 23505(동시 생성)로 실패하면 상계는 이미 커밋되어 미수금이 줄고 정산서 `payoutAmount`가 깎였는데 배치·지급은 없다. 재시도하면 남은 미수금 기준으로 다시 상계하므로 총액은 맞지만, "상계됐는데 지급 없는" 구간이 남는다.
- 왜 문제인가: 그 상태로 지급이 영영 안 되면 PEAKET이 미수금을 탕감한 셈이 된다. 기존 구조의 문제이고 R-599가 만든 것은 아니지만, 결속을 트랜잭션으로 묶은 김에 상계까지 같은 트랜잭션에 넣는 것이 자연스럽다.
- 제안 수정: 상계 루프와 배치 결속을 한 트랜잭션으로 묶는다(포트에 트랜잭션 경계를 넘기거나 `createPayoutBatchWithStatements`가 상계 계획까지 받는다).
- 확신도: 중간.

---

## 6. 원복 증거

기준(검증 시작, 다른 에이전트 작업 포함) SHA-256 앞 16자리:

| 파일 | 기준 | 최종 |
| --- | --- | --- |
| `adapters/memory-settlement-store.ts` | `9071D811A17A8261` | `9071D811A17A8261` |
| `application/settlements.ts` | `10C86D718184684E` | `10C86D718184684E` |
| `adapters/db/drizzle-settlement-store.ts` | `A7E1A2B1D0BDEC36` | `A7E1A2B1D0BDEC36` |

- `git grep "&& false" services/payment-svc/src/modules/settlement` → 0건.
- `git diff --stat` 대상 2파일(memory·drizzle) → 출력 없음(HEAD와 동일).
- `settlements.ts`의 diff는 다른 에이전트의 기존 45줄(44+/1-) 그대로이며 내 변이 흔적 없음.
- HEAD는 `e24ee8f8` 그대로.
- **`git status --short`는 깨끗하지 않다**(검증 중 10→25건). 전부 다른 에이전트의 미커밋 작업이며, 내가 만든 변경은 없다. 이 worktree를 깨끗하게 만들려면 그 작업을 지워야 하므로 하지 않았다.

---

## 7. 남은 위험 (R-599 범위 밖, 우선순위)

1. **CONS-03 미해결(중간)**: `PayoutSubmitResult.pgPayoutIds`를 여전히 읽지 않고(`ports.ts:101` 정의만), `payout.status`를 바꾸는 코드가 없으며(`REQUESTED` 고정), `PARTIAL_FAILED`·`retryPayout`(FAILED만 허용)은 도달 불가. 실 결제사가 `COMPLETED`를 돌려주면 모든 정산서를 `PAID`로 쓰면서 `payout`은 `REQUESTED`라 일일 불변식 M1이 **항상** 위반된다. 지급 어댑터를 켜기 전 선행 수정 필요.
2. **`executeBatch` 동시 호출(중간)**: 두 파드가 동시에 실행하면 `payout_ref_key` 유일 인덱스가 중복 지급 행은 막지만, 진 쪽은 23505를 매핑하지 않아 500이 된다. 또 게이트웨이 응답을 잃고 재시도하면 같은 `refPayoutId`로 다시 제출하므로 결제사 멱등성에 의존한다(어댑터 계약에 멱등키 요구가 없다).
3. **CONS-V02·V03**는 위 발견 참조. V02는 반려·방치 한 번으로 지급일이 막히므로 운영 콘솔에 "묶음 취소"가 생기기 전까지 우선순위가 높다.
4. **정산서 재계산(revision/supersedes) 경로가 아직 없다.** 부분 유일 인덱스는 `SUPERSEDED`를 제외하므로, 재계산을 넣을 때 **옛 정산서를 먼저 SUPERSEDED로 바꾼 뒤** 새 정산서를 넣어야 한다. 순서를 뒤집으면 23505로 막힌다(설계 제약으로 기록 필요).
