# 작업 계획: FIX-invariant-m3 — 미수금 이동 표 이름을 정본대로 바꾸고 M3가 실제 DB에서 돌게 한다

- **무엇**: 불변식 검사기(시험이 끝난 뒤 DB를 대조해 돈·좌석 규칙 위반을 세는 도구)의 M3 '미수금 남은 금액 = 금액 − 이동 기록 합 ≥ 0'이 실제 payment DB에서 한 번도 돌지 않았다. 검사기는 정본 이름 `receivable_movement` 표를 찾는데, payment-svc 마이그레이션(DB 구조를 차례로 바꾸는 SQL 파일) 0016이 그 표를 `receivable_move`로 만들어 '원본에 표 없음'으로 건너뛰기(SKIPPED) 때문이다. 이 묶음은 ① payment 표 이름을 정본대로 바꾸는 마이그레이션 0028을 확장·축소 규칙의 첫 걸음으로 내고 ② 건너뛴 불변식이 조용히 묻히지 않게 검사기 출력에 드러내며 ③ M3가 마이그레이션을 모두 적용한 실제 payment DB에서 도는지를 시험으로 묶는다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane5-FIX-invariant-m3`, 가지 `feature/lane5-FIX-invariant-m3`, 출발점 `origin/develop` `f8fd325ff`. 감독 요청과 `docs/lanes/lane5-cleanup.md` 22줄(FIX-payment-int 리뷰 RV-02), 23줄의 이름 차이 부분. 마이그레이션 번호 0028은 갈래 5 몫이다(`docs/lanes/coord.md`, `39785d9ec`).
- **정본**: 표 이름 `docs/data.md` §2 ERD `receivable_movement`(1119·1120·1262·1371·1375줄)와 `docs/features/settlement.md` §7 '미수금 이동 기록'·저장소 표, 표 이름 바꾸기 단계 `docs/data.md` §4 '미수금 이동 기록 표 이름 맞추기'(이 커밋에서 씀), 데이터 변경 규칙 `docs/devops.md` §7.1~7.3, 검사기 `docs/verification.md` §2.5(건너뜀 드러내기는 이 커밋에서 씀)·§3.10 'v1 합본 측정 규칙', 묶음 절차 `docs/architecture.md` §8.6. 이 문서는 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **등급·차례**: A(돈 불변식·결제 DB 마이그레이션). 코드 묶음, 정방향(`Batch-Order: impl-first`, `docs/architecture.md` §8.6 4): 계획 → 구현 → 시험 → 리뷰 → 검증 → 기록.
- **선행 조건**: 갈래 5의 F-07-5가 payment 0027을 `develop`에 먼저 합친다(감독 전제). 구현 담당은 시작할 때 `origin/develop`에 `0027_*.sql`이 있는지 보고, 있으면 그 위로 다시 쌓은 뒤 0028을 만든다. 없으면 감독에게 알리고 기다린다. Drizzle 마이그레이터는 적용 기록의 마지막 `when`(만든 시각)보다 늦은 것만 돌리고 snapshot은 `prevId`로 사슬을 이루므로, 0027보다 먼저 만든 0028을 뒤에 옮기면 기록 시각과 사슬을 다시 만들어야 한다.

## 원인

| # | 무엇이 어긋났나 | 자리 | 근거 |
| --- | --- | --- | --- |
| ⑴ | 마이그레이션이 정본 ERD와 다른 표 이름을 썼다 | `services/payment-svc/migrations/0016_receivables.sql` 17줄 `CREATE TABLE "receivable_move"`, 0026 22~31줄이 같은 이름에 `id`·`kind`·인덱스·CHECK를 더함, `src/modules/settlement/adapters/db/schema.ts` 273~293줄 | ERD `receivable_movement`(`docs/data.md` 1375줄), settlement.md §7 '미수금 이동 기록'·결과 표 503줄 |
| ⑵ | 검사기는 정본 이름을 쓰므로 실제 DB에서 M3를 건너뛴다 | `services/invariant-checker/src/tables.ts` 35줄, `src/invariants.ts` 45줄(M3 `requires`), `src/run.ts` 109줄(`원본에 표 없음`) | `docs/verification.md` §2.5 '결과 파일': 표가 없으면 SKIPPED |
| ⑶ | 검사기 통합 시험은 손으로 만든 정본 이름 표를 써서 차이를 못 봤다 | `services/invariant-checker/test-int/postgres.ts` 80줄 | — |
| ⑷ | 건너뛴 불변식은 종료 코드에도 요약에도 안 드러난다. 측정 실행 도구 중 기대 목록을 대조하는 것은 v1 경로뿐이다 | `src/report.ts` `exitCode`(FAIL만 1), `src/cli.ts` 38줄(줄마다 결과만), `loadtest/runner/v1.mjs` 9줄 | `docs/architecture.md` §8.6 '자주 놓친 결함': 측정 도구는 SKIPPED가 '통과'로 새지 않는지 단언한다 |
| ⑸ | v1 기대 SKIPPED 목록이 낡았다. v1 무대의 결제 DB는 payment-svc 마이그레이션을 모두 적용하므로(`tools/local/v1-objects.mjs` 347~373줄 → `services/payment-svc/scripts/migrate.mjs`) 0015·0016 뒤로 M1·M2·M4·M5는 표가 있어 세어진다. 이 묶음 뒤에는 M3도 세어진다 | `loadtest/runner/v1.mjs` 9줄 `['M1','M2','M3','M4','M5','P5','S3']` | 정본을 이 커밋에서 'S3·P5'로 고침(`docs/verification.md` §3.10) |

- **정본이 이긴다**: 표 이름은 코드를 고친다. 정본은 이름 쪽은 바꾸지 않았다. 정본 안에서 실제 이름을 적은 저장소 표 한 곳(`docs/features/settlement.md` 저장소 표의 `receivable_move.id`·`kind`)만 정본 이름으로 맞추고 0028을 가리켰다.

## 판단 1: 확장·축소

- 규칙(`docs/devops.md` §7.1): 모든 스키마 변경은 실행 중인 판(N-1)과 새 판(N)에 함께 맞아야 하고(원칙 2), 맞지 않는 변경은 확장 → 이전 → 축소로 배포 2회 이상에 나누며, 스키마 변경과 그것에 기대는 코드 변경은 같은 배포에 넣지 않는다(원칙 3). 표 이름 바꾸기는 N-1이 옛 이름으로 쓰므로 맞지 않는 변경이다. 한 번에 바꾸면 규칙을 어긴다.
- 방법: **표 이름을 바꾸고 옛 이름에 자동 갱신 뷰를 둔다.** PostgreSQL은 표 하나를 그대로 보이는 단순 뷰의 넣기·고치기·지우기를 밑 표로 넘기고, 넣지 않은 칸에는 밑 표의 기본값을 쓴다(뷰 칸에 기본값을 따로 걸지 않았을 때). 그래서 데이터가 한 표에 있어 옮길 행(이전 단계의 백필)이 없고, 두 이름이 같은 행을 본다. 열 이름 바꾸기 예시(§7.1 표)의 '두 열에 쓴다'가 여기서는 '두 이름이 한 표'다.
- 세 출시로 나눈다(정본 `docs/data.md` §4 '미수금 이동 기록 표 이름 맞추기', 이 커밋에서 씀):

| 단계 | 스키마 | 앱 | 이 묶음 |
| --- | --- | --- | --- |
| ① 확장 | 0028: 표·기본 키·CHECK 둘·외래 키 둘·인덱스의 이름만 바꾸고(메타데이터만, 다시 쓰기·다시 검증 없음) 옛 이름 뷰 `receivable_move`(`security_invoker = true`)를 만든다 | N: 옛 이름(뷰)으로 그대로 읽고 쓴다 | **여기** |
| ② 이전 | 없음 | N+1: 새 이름으로 읽고 쓴다. 되돌리면 N은 뷰로 돈다 | 넘김(①이 든 출시 태그 뒤) |
| ③ 축소 | `DROP VIEW receivable_move` | N+2 | 넘김(② 출시 7일 뒤 [가정]) |

- 검사기는 운영에 배포하지 않는 시험 도구라 ① 직후부터 `receivable_movement`(표)를 읽어 M3를 센다. M3를 살리는 데 ②·③은 필요 없다.
- 운영 전이라 줄이고 싶다면(한 출시에 ①②를 함께) 정본 규칙의 예외라 ADR이 필요하다. 이 계획은 줄이지 않는다.
- 뷰의 권한: payment 마이그레이션에는 GRANT가 없다(역할·권한은 마이그레이션 실행기 BAS-060 몫). 이름을 바꿔도 표의 권한은 남는다. 뷰는 `security_invoker = true`로 부르는 역할의 표 권한으로 따지게 해, 뷰를 만든 DDL 역할의 권한으로 표에 닿는 길을 만들지 않는다. 뷰 자체의 권한은 BAS-060이 표와 같은 기본 권한으로 준다(로컬·CI는 관리 역할이라 해당 없음).

## 판단 2: 건너뜀(SKIPPED)은 설계인가

- **설계다.** 근거: `docs/verification.md` §2.5 '결과 파일'이 '원본 DB나 표, 시험 기록이 없으면 SKIPPED'와 'FAIL이면 종료 코드 1'을 정하고, §3.10이 v1 무대의 기대 SKIPPED 목록과 '다르면 실행 도구가 실패하고 그 실행을 무효로 남긴다'를 정한다. 무대마다 없는 원본이 정말 있다(v0에는 정산 표가 없고, v1 합본에는 티켓 원본이 없다). 그래서 SKIPPED를 실패로 바꾸지 않고 종료 코드도 그대로 둔다(바꾸면 v0·v1 실행 도구가 '검사기 실패'로 끝난다, `loadtest/run.mjs` 645·1738줄).
- **정본 빈칸**: 검사기 자체가 SKIPPED를 어떻게 드러내는지는 비어 있었다. 이 커밋에서 §2.5 '건너뜀(SKIPPED)을 드러내기'로 썼다: ① 결과별 개수와 SKIPPED 불변식·까닭의 요약 한 줄(표준 출력) ② 까닭을 셋(시험 기록 없음·원본 없음·원본에 표 없음)으로 나누고, 붙은 원본에 표가 없는 것만 표준 오류에 경고 한 줄 ③ 무대마다 기대 목록 대조는 실행 도구 몫(§3.10). 또 검사기 표 목록을 실제 마이그레이션 DB로도 시험한다는 문장을 더했다.
- **낡은 정본 고침**: §3.10 v1 기대 목록을 'S3·P5'로 고쳤다(원인 ⑸). 구현은 `V1_EXPECTED_SKIPPED`를 같이 고친다.
- **ADR**: 필요 없다. 새 기술이나 방향을 고르지 않았고, 정본 규칙(§7.1 확장·축소, §2.5·§3.10 SKIPPED)을 지키는 방법과 빈칸을 '추천 적용'으로 채웠다.

## 고칠 곳(구현 담당)

| # | 파일 | 바꿀 것 |
| --- | --- | --- |
| I1 | `services/payment-svc/migrations/0028_receivable_movement_rename.sql`(새), `meta/0028_snapshot.json`(새), `meta/_journal.json` | 아래 'SQL 0028'의 문장만 둔다. snapshot·journal은 drizzle-kit이 만든 것을 쓴다(I2 뒤 `pnpm --filter @peaket/payment-svc db:generate --name receivable_movement_rename`, 이름 바꾸기 물음에 `receivable_move`에서 바꿈을 고른다. 묻는 화면을 못 쓰면 0027 snapshot을 복사해 새 `id`·`prevId`(0027 `id`)·표·제약·인덱스·외래 키 이름만 바꿔 손으로 만든다). 생성된 SQL은 제약을 지우고 다시 걸며(외래 키 다시 검증, 무거운 잠금)·인덱스를 다시 만들므로 이름만 바꾸는 문장으로 갈아 끼운다(§7.2·§7.3). 끝에 `db:generate`를 다시 돌려 '바뀐 것 없음'이어야 한다 |
| I2 | `services/payment-svc/src/modules/settlement/adapters/db/schema.ts` 273~293줄 | `receivableMovement = pgTable('receivable_movement', …)`, 인덱스 `receivable_movement_receivable_idx`, CHECK `receivable_movement_amount_check`·`receivable_movement_kind_check`. 칸·외래 키 대상은 그대로. 옛 `receivableMove` 내보내기는 없앤다 |
| I3 | `services/payment-svc/src/modules/settlement/adapters/db/receivable-move-compat.ts`(새), `drizzle-settlement-store.ts` 6·355·864·875·880·925줄 | 단계 ①의 앱은 옛 이름을 쓴다(판단 1). 새 파일에 옛 이름 `pgTable('receivable_move', …)`(칸은 I2와 같고 제약·인덱스는 두지 않음)을 `receivableMoveCompat`로 두고 저장소는 이것을 쓴다. 파일은 drizzle 설정의 표 정의 글로브(`./src/modules/*/adapters/db/schema.ts`) 밖이라 생성기가 표로 보지 않는다. 머리 주석에 '단계 ② 묶음이 지운다(docs/data.md §4 미수금 이동 기록 표 이름 맞추기)'를 적는다 |
| I4 | `services/invariant-checker/src/report.ts`, `src/run.ts` 97~111줄 | `InvariantResult`에 `skip?: { kind: 'records' \| 'source' \| 'table'; names: string[] }`를 더하고 run.ts의 세 SKIPPED 자리에서 채운다(`reason` 글은 그대로). report.ts에 순수 함수 `summaryLine(results)`·`skipWarnings(results)`를 더한다(아래 '공개 인터페이스'). CSV·ndjson 형식과 `exitCode`는 그대로 |
| I5 | `services/invariant-checker/src/cli.ts`, `src/cli-main.ts`(새) | `main()`의 몸을 `runCli(argv, env, io)`로 옮겨 내보내고(시험이 바깥 경계로 부르게), cli.ts는 그것을 불러 `process.exit`만 한다. 줄마다 결과 뒤에 요약 한 줄을 표준 출력에, `skipWarnings`를 표준 오류에 낸다. 끝 코드 0·1·2 뜻은 그대로 |
| I6 | `loadtest/runner/v1.mjs` 6~9줄 | `V1_EXPECTED_SKIPPED = ['P5', 'S3']`, 주석을 정본 §3.10 새 문장에 맞춘다 |

- 그 밖에 이 묶음이 고치지 않는다: `tables.ts`·`invariants.ts`·`sql/`(이미 정본 이름), 계약, purchase-svc·bundle 원본(둘 다 payment-svc 원본과 `migratePayment`를 가져다 쓰므로 타입 검사·통합 시험으로 확인만 한다).
- 구현 담당이 돌려 보면 깨질 기존 시험(시험 담당이 고친다): payment `test/payment-schema.test.ts` 715·716줄 파일 목록과 `when` 차례(0027·0028), `test-int/payment-grpc.int.test.ts` 173줄 PRF180 표 목록(`receivable_move` → `receivable_movement`), `test-int/compensation-transfer.int.test.ts` 32줄 `RESET_SQL`(뷰는 `truncate`할 수 없다), `test-int/settlement.int.test.ts` 193~196줄(`information_schema.tables`에 뷰도 나온다), `loadtest/test/v1.test.mjs` 359~364줄, `loadtest/e2e/v1-rehearsal.e2e.mjs` 132줄(kind 무대라 CI 밖).

### SQL 0028

```sql
-- 미수금 이동 기록 표 이름을 정본(docs/data.md ERD receivable_movement)에 맞춘다(FIX-invariant-m3).
-- 확장 단계(docs/devops.md §7.1, docs/data.md §4 '미수금 이동 기록 표 이름 맞추기'): 이름만 바꾸고 옛 이름은 자동 갱신 뷰로 남긴다.
ALTER TABLE "receivable_move" RENAME TO "receivable_movement";--> statement-breakpoint
ALTER INDEX "receivable_move_pkey" RENAME TO "receivable_movement_pkey";--> statement-breakpoint
ALTER INDEX "receivable_move_receivable_idx" RENAME TO "receivable_movement_receivable_idx";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_amount_check" TO "receivable_movement_amount_check";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_kind_check" TO "receivable_movement_kind_check";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_receivable_id_partner_receivable_id_fk" TO "receivable_movement_receivable_id_partner_receivable_id_fk";--> statement-breakpoint
ALTER TABLE "receivable_movement" RENAME CONSTRAINT "receivable_move_statement_id_settlement_statement_id_fk" TO "receivable_movement_statement_id_settlement_statement_id_fk";--> statement-breakpoint
CREATE VIEW "receivable_move" WITH (security_invoker = true) AS SELECT "id", "receivable_id", "statement_id", "amount", "kind", "moved_at" FROM "receivable_movement";
```

- 기본 키 이름 `receivable_move_pkey`는 0026의 `ADD COLUMN "id" uuid PRIMARY KEY`가 PostgreSQL 기본 규칙으로 지은 것이다. 구현 담당은 0026까지 적용한 DB의 `pg_constraint`로 실제 이름을 한 번 확인한다. 새 외래 키 이름(58·59자)은 이름 상한 63바이트 안이다.

## 공개 인터페이스

- **payment DB**: 표 `receivable_movement`(칸 그대로), 제약·인덱스 `receivable_movement_pkey`·`_amount_check`·`_kind_check`·`_receivable_id_partner_receivable_id_fk`·`_statement_id_settlement_statement_id_fk`·`_receivable_idx`. 뷰 `receivable_move`(같은 칸 여섯, 단계 ③에서 지움).
- **payment-svc 코드**: `schema.ts`의 `receivableMovement`(옛 `receivableMove` 없앰), `receivable-move-compat.ts`의 `receivableMoveCompat`(단계 ②에서 지움).
- **검사기**:
  - `InvariantResult.skip?: { kind: 'records' | 'source' | 'table'; names: string[] }`. `records`는 `names` 빈 배열, `source`는 없는 원본 이름, `table`은 없는 표 이름.
  - `summaryLine(results): string` 예 `요약: PASS 9 · FAIL 0 · SKIPPED 8 — M1(원본에 표 없음: settlement_statement), P5(원본 없음: ticket), …`. SKIPPED가 없으면 `— SKIPPED 없음`. 차례는 `INVARIANTS` 차례.
  - `skipWarnings(results): string[]`: `skip.kind === 'table'`인 결과마다 `경고: M3 원본(payment)에 붙었는데 표가 없다: receivable_movement — 기능이 아직 없거나 표 이름이 docs/data.md와 다르다` 꼴의 한 줄. 다른 까닭은 넣지 않는다.
  - `runCli(argv, env, io: { stdout(s: string): void; stderr(s: string): void }): Promise<number>`(`src/cli-main.ts`). 표준 출력: 지금의 불변식별 줄 + 요약 한 줄. 표준 오류: 경고 줄. 끝 코드: FAIL이 있으면 1, 아니면 0(SKIPPED만 있어도 0), 인자·연결·기록 오류 2.
- **loadtest**: `V1_EXPECTED_SKIPPED`가 `['P5', 'S3']`.

## 시험 목록(시험 담당)

이름에 ID를 단다. 검사기 쪽은 감독이 준 커밋 ID(J-T25, M3)를 따라 `J-T25 M3 ①…`로 쓴다(J-T25의 세부 ①~③은 지급대행 잔액 대사라, ID 바로 뒤에 번호를 붙이지 않아 그 세부를 채운 것으로 세지 않게 한다). payment 쪽은 표 모양 시험의 ID `PRF180`을 쓴다. 기존 시험의 이름은 바꾸지 않는다.

| ID | 자리 | 무엇을 보나 |
| --- | --- | --- |
| J-T25 M3 ① | `services/invariant-checker/test-int/payment-migrated.int.test.ts`(새). `test-int/postgres.ts`의 `DATABASES`에 빈 DB `payment_migrated`를 더하고 `migratePayment`(`../../payment-svc/scripts/migrate.mjs`, bundle·purchase-svc 시험과 같은 가져오기)로 마이그레이션 전부를 적용한다 | payment 원본으로 이 DB를 주면 `tables.ts`의 payment 표 아홉이 모두 실리고(칸이 없으면 읽기가 오류로 끝난다), payment 표만 쓰는 불변식(P1·M1~M5)은 SKIPPED가 아니며, 어떤 결과에도 `skip.kind === 'table'`이 없다 |
| J-T25 M3 ② | 같은 파일 | 같은 DB에 정본 칸·외래 키를 지켜 정산서 둘, 미수금 하나(100만 원), `receivable_movement`에 상계 30만·보증 충당 20만(`GUARANTEE`)·상계 50만·되돌림 50만(`REVERSAL`)을 넣고 `remaining`을 50만 원으로 두면 M3는 PASS 0건이다. `remaining`을 0으로 바꾸면 FAIL 1건이고 위반 행이 `amount=1000000 remaining=0 moved=500000`이다. 넣기는 새 이름 표로 한다 |
| J-T25 M3 ③ | `test-int/invariants.int.test.ts`(기존 파일에 새 시험) | 붙은 원본에 표가 없으면(`bare` DB) 그 불변식의 `skip`이 `{ kind: 'table', names: […] }`이고 `skipWarnings`에 든다. 원본을 주지 않은 것(`skip.kind === 'source'`)과 기록이 없는 것(`records`)은 `skipWarnings`에 없다 |
| J-T25 M3 ④ | `test/report.test.ts` | `summaryLine`이 PASS·FAIL·SKIPPED 개수와 SKIPPED ID·까닭을 `INVARIANTS` 차례로 적고, SKIPPED가 없으면 `SKIPPED 없음`이다. `skipWarnings`는 `table`만 줄로 낸다 |
| J-T25 M3 ⑤ | `test-int/payment-migrated.int.test.ts` | `runCli`를 실제 DB 주소(환경 값)로 부르면 ① payment만 준 실행은 표준 출력 끝 줄이 요약이고 끝 코드 0(SKIPPED만 있음)이며 표준 오류가 비었다 ② payment 원본으로 `bare`를 주면 표준 오류에 M1~M5 경고가 나고 끝 코드는 0이다 ③ ②의 미수금을 틀리게 둔 실행은 끝 코드 1이다. `invariants.csv`가 세 경우 모두 써진다 |
| PRF180 M3 ⑥ | `services/payment-svc/test/settlement-migration.test.ts`(기존 파일에 새 시험) | 0028 SQL에 위 'SQL 0028'의 이름 바꾸기 일곱 문장과 `CREATE VIEW "receivable_move" WITH (security_invoker = true)`가 있고, `DROP`·`ADD CONSTRAINT`·`CREATE INDEX`·`CREATE TABLE`이 없다. journal의 `idx` 28이 이 파일이고, 0028 snapshot에 `public.receivable_movement`(제약·인덱스·외래 키 이름이 모두 `receivable_movement_` 머리)가 있고 `public.receivable_move`가 없으며 `prevId`가 0027 snapshot의 `id`다 |
| PRF180 M3 ⑦ | `services/payment-svc/test-int/settlement.int.test.ts`(새 시험) | 마이그레이션 뒤 `pg_constraint`·`pg_indexes`에서 `receivable_movement`의 제약 다섯·인덱스 둘 이름이 새 머리이고 `receivable_move_`로 시작하는 이름이 어디에도 없으며, `pg_class`에서 `receivable_move`는 뷰(`relkind = 'v'`)이고 `reloptions`에 `security_invoker=true`가 있다 |
| PRF180 M3 ⑧ | 같은 파일 | N-1 앱처럼 옛 이름 뷰에 `id`·`kind` 없이 넣으면 새 UUID와 `OFFSET`으로 `receivable_movement`에 들어가고 옛 이름으로도 읽힌다. 뷰로 금액 0을 넣으면 `receivable_movement_amount_check`, 없는 미수금을 넣으면 `receivable_movement_receivable_id_partner_receivable_id_fk` 위반으로 막힌다 |
| (기존, 이름 그대로) | `payment-schema.test.ts` 715·716줄·`when` 차례, `payment-grpc.int.test.ts` 173줄(PRF180), `compensation-transfer.int.test.ts` 32줄, `settlement.int.test.ts` 193~196줄(표는 `BASE TABLE`, 옛 이름은 `VIEW`로 기대), `loadtest/test/v1.test.mjs` 359~370줄(기대 목록 `['P5','S3']`, M3가 SKIPPED면 '더 M3'), `v1-rehearsal.e2e.mjs` 132줄 | 고친 기대값만 따라잡는다. 다른 단언은 약하게 하지 않는다 |

- 단계 ①의 앱이 옛 이름(뷰)으로 돌므로, payment-svc 통합 시험 전부(settlement·compensation-transfer·settlement-a1v 등)가 그대로 'N-1 앱의 통합 시험 묶음을 새 스키마에서 실행'(`docs/devops.md` §7.3 적용 시험 ③)이 된다. 새 시험을 따로 두지 않는다. 시험의 날 SQL(`select … from receivable_move`)도 그대로 둔다(단계 ②가 새 이름으로 바꾼다).
- 시험은 `docs/architecture.md` §8.6 '자주 놓친 결함'과 `peaket-test-antipatterns` 지침을 따른다. 특히 ①은 손으로 만든 표가 아니라 마이그레이션을 적용한 DB여야 하고, ⑤는 판정 함수가 아니라 명령 경계(`runCli`)를 본다.

## 실패 확인

시험 담당이 채운다. 정방향 묶음이라 구현 뒤에 쓰므로, 새 시험이 잡는 것은 아래 '틀린 구현 표본'과 이 계획 커밋 트리의 실제 동작(0026까지 적용한 payment DB에서 M3가 `원본에 표 없음: receivable_movement`로 SKIPPED)으로 보인다.

- 방법: 이 계획 커밋(`19386edc2`)을 따로 꺼낸 작업 폴더(`D:/l5m3pre`, 설치 폴더는 이 작업 폴더의 것을 이어 붙임)에 시험 파일만 옮겨 돌렸다. 통합은 Docker 잠금을 잡고 실제 PostgreSQL 18로 돌렸다. 끝난 뒤 작업 폴더를 지웠다.
- 단위(8 실패): 검사기 `test/report.test.ts` J-T24 ④ 셋(`summaryLine`·`skipWarnings` 없음), payment `test/settlement-migration.test.ts` PRF180 M3 ⑥(0028 없음)과 `test/payment-schema.test.ts` 기록 차례·파일 목록 둘(0028 없음), `loadtest/test/v1.test.mjs` PRF215 코드리뷰 H2·재확인1 둘(기대 목록이 아직 M1~M5를 품음).
- 통합(19 실패): 검사기 J-T24 ③(`skip` 칸 없음) 하나, `test-int/payment-migrated.int.test.ts` 다섯(①②⑤, `runCli`가 없어 파일 가져오기에서 실패). 가져오기 실패가 아니라 실제 동작으로 지는지 보려고 `runCli` 부분을 뺀 사본으로 ①②만 다시 돌렸다: ①은 0027까지 적용한 DB에서 M3가 `SKIPPED`라 지고, ②는 `relation "receivable_movement" does not exist`로 진다. payment `settlement.int.test.ts` 넷(0016 표 목록, PRF180 M3 ⑦⑧⑨), `payment-grpc.int.test.ts` PRF180 표 목록 하나, `compensation-transfer.int.test.ts` 여덟(`RESET_SQL`의 `receivable_movement`가 없음).
- 합계 27개가 계획 트리에서 지고 구현 트리에서 통과한다(아래 '시험 결과').

## 확인 명령

Docker가 필요하다. 잠금을 잡고 돌린 뒤 놓는다(잠금이 비어 있지 않으면 기다린다. 갈래 안에서 한 담당만 잡는다).

```bash
bash D:/ticketpass-locks/lock.sh take docker lane5-FIX-invariant-m3
pnpm exec turbo run build --filter=@peaket/payment-svc^... --filter=@peaket/invariant-checker^... --filter=@peaket/search-normalize --filter=@peaket/pg-simulator
pnpm --filter @peaket/payment-svc db:generate                 # 바뀐 것 없음(snapshot = schema.ts)
pnpm --filter @peaket/payment-svc test
pnpm --filter @peaket/invariant-checker test
pnpm --filter @peaket/payment-svc test:integration             # 전부(뷰로 도는 N-1 호환 포함)
pnpm --filter @peaket/invariant-checker test:integration
pnpm exec turbo run build --filter=@peaket/bundle...
pnpm --filter @peaket/bundle test:integration                   # 합본 시작 파일이 0028을 적용한 DB에서 뜬다
bash D:/ticketpass-locks/lock.sh drop docker lane5-FIX-invariant-m3
node --test loadtest/test/v1.test.mjs
pnpm exec turbo run typecheck --filter=@peaket/payment-svc --filter=@peaket/invariant-checker --filter=@peaket/purchase-svc --filter=@peaket/bundle
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
```

- 통과 기준: 위 시험 전부 실패 0, `db:generate` 바뀐 것 없음, typecheck·lint 0, doc-check 오류 0, roles-check가 이 묶음을 '코드(정방향)'로 센다. purchase-svc는 payment-svc 원본을 가져다 쓰므로(CLAUDE.md) 타입 검사를 함께 돌린다.

## 틀린 구현 표본(검증 담당용)

| # | 넣을 틀린 것 | 잡을 검사 |
| --- | --- | --- |
| S1 | 0028에서 `CREATE VIEW`를 뺀다(한 번에 이름만 바꿈) | PRF180 M3 ⑥·⑦·⑧과 payment-svc 통합 시험 전부(저장소가 옛 이름을 쓴다) |
| S2 | 0028을 drizzle-kit이 만든 그대로 둔다(제약 지우고 다시 걸기·인덱스 다시 만들기) | PRF180 M3 ⑥ |
| S3 | 표 이름만 바꾸고 제약·인덱스 이름은 `receivable_move_…`로 둔다 | PRF180 M3 ⑦(⑥도) |
| S4 | 0028이 다른 이름(`receivable_movements`)으로 바꾼다, 또는 `tables.ts`를 `receivable_move`로 되돌린다 | J-T25 M3 ①(M3 SKIPPED·`table` 까닭)과 PRF180 표 목록 |
| S5 | 뷰를 `security_invoker` 없이 만든다 | PRF180 M3 ⑥·⑦ |
| S6 | `skipWarnings`가 `source`·`records` 까닭도 경고로 낸다, 또는 `summaryLine`이 SKIPPED 목록을 빠뜨린다 | J-T25 M3 ③·④ |
| S7 | `runCli`가 SKIPPED가 있으면 끝 코드 1을 낸다, 또는 경고를 표준 출력에 섞는다 | J-T25 M3 ⑤ |
| S8 | M3 SQL에서 `REVERSAL`을 더하기로 바꾼다 | J-T25 M3 ②(실제 스키마의 되돌림 행으로) |
| S9 | `V1_EXPECTED_SKIPPED`에 M3를 남긴다 | `loadtest/test/v1.test.mjs` PRF215 코드리뷰 H2 |

- 저장소가 단계 ①에서 새 이름 표를 바로 쓰는 것(원칙 3 위반)은 시험으로 잡히지 않는다(동작은 같다). 리뷰가 I3을 본다.

## 넘기는 것

- **단계 ② → F-07-6(감독 결정, 리뷰 RV-01)**: 저장소를 `receivableMovement`로 바꾸고 `receivable-move-compat.ts`를 지우며 시험의 날 SQL을 새 이름으로 바꾼다. 마이그레이션 없음.
  - 시작 조건: 0028이 든 출시 태그가 있어야 한다. 없으면 F-07-6은 `receivableMoveCompat`을 그대로 쓰고 ②를 다음 묶음으로 미룬다(또는 ①②를 한 출시에 합치는 예외 ADR을 먼저 낸다). F-07-6은 미수금 상계를 맡아 같은 저장소(`drizzle-settlement-store.ts`)를 고치므로, 새 이름으로 바꾸고 싶어질 자리다.
- **단계 ③ → F-07-7(감독 결정, 리뷰 RV-01·RV-07)**: `DROP VIEW "receivable_move"` 마이그레이션(그때의 다음 번호). 같은 마이그레이션에서 0028이 남긴 옛 머리의 NOT NULL 제약 이름 여섯(`receivable_move_*_not_null`)을 `RENAME CONSTRAINT`로 `receivable_movement_…`로 바꾼다(PostgreSQL 18은 NOT NULL도 이름 있는 제약으로 두고 표 이름을 바꿔도 따라 바꾸지 않는다).
  - 시작 조건: ②가 든 출시가 나간 지 7일 [가정] 뒤(`docs/devops.md` §7.1 원칙 3 표의 '축소'). 그 전이면 F-07-7은 ③을 하지 않고 미룬다.
- **'출시'를 무엇으로 세나(감독 질문)**: 정본은 앱 배포를 `develop` 합치기가 아니라 출시 후보·출시 태그로 센다. `docs/devops.md` §3.2 유형별 필수 검사 표(서비스 줄): `develop` 병합 뒤에는 검사·CI kind E2E·야간 시험만 돌고, 이미지 빌드·푸시와 데모 승격 PR은 릴리스·핫픽스 가지(출시 후보)에서, 태그와 운영 승격 PR은 `main` 병합 뒤에 한다. 같은 문서 §2.2.5 표(133줄) '출시 후보는 마지막 출시 태그 뒤에 바뀐 배포 단위만 새 이미지로 만든다', 462~480줄 승격 흐름과 '출시 확정은 `main`의 태그'. 144·410줄과 CLAUDE.md의 'Argo CD가 `develop`에서 읽음'·'`develop`에 병합하는 것이 곧 배포'는 `deploy/`(배포 상태)를 고치는 합치기에 대한 말이고, 환경에 무엇이 올라가는지는 환경 디렉터리의 다이제스트(승격 PR)가 정한다. 1인 기간의 `develop` 바로 쌓기(`docs/architecture.md` §8.6 10)는 합치는 방법이지 배포 단위가 아니다. 그래서 이 계획은 ②·③의 조건을 출시 태그 기준으로 둔다. `develop` 합치기 기준으로 바꾸지 않았다.
- **칸 차이**: ERD `receivable_movement`는 `created_at`·`reverses_id`(되돌린 기록)·`statement_id` 널 허용(보증·회수는 정산서 없음)인데 0016·0026은 `moved_at`·`reverses_id` 없음·`statement_id NOT NULL`이다. M3는 이 칸들을 읽지 않아 이 묶음 밖이다. 되돌림(`REVERSAL`)을 처음 쓰는 단계 전에 맞춰야 한다(정본과 코드 어느 쪽을 고칠지 포함). `docs/lanes/lane5-cleanup.md`에 줄을 더한다(기록 담당).
- **ERD 누락**: `lane5-cleanup.md` 23줄의 표 셋·`seller_kyc` 칸 누락은 그대로 남는다(이 묶음은 이름 차이만 닫는다).
- **다른 원본의 같은 시험**: purchase·ticket 원본 표(S1~S4·P3~P5)도 손으로 만든 표로만 시험한다. 서비스 마이그레이션을 적용한 DB로 J-T25 M3 ①과 같은 시험을 두는 일은 따로 한다.
- **v0 실행 도구(리뷰 RV-02)**: v0 경로(`loadtest/run.mjs` `runInvariants`)는 기대 SKIPPED 목록을 대조하지 않고 끝 코드만 본다. `v0_check`에는 정산 표가 없어 이 묶음 뒤 v0 실행마다 M1~M5 '원본에 표 없음' 경고가 표준 오류에 나온다(늘 나는 경고가 되어 무시되기 쉽다). 정본 §2.5 ③은 이 커밋에서 'v1 실행 도구가 대조한다'로 좁혔다. v0 기대 목록(M1~M5와 실측으로 정할 것)을 두고 대조하며, 기대한 표 없음은 경고에서 빼는 일을 따로 한다(시험·구현 담당 몫).
- **CLAUDE.md의 상대 경로 가져오기 목록**: invariant-checker 통합 시험이 `services/payment-svc/scripts/migrate.mjs`를 읽게 된다(bundle·purchase-svc도 이미 읽지만 목록에 없다). 목록을 고칠지는 소유자 몫이다.
- **v1 리허설**: 기대 목록을 고쳤지만 kind 무대 리허설(`loadtest/e2e/v1-rehearsal.e2e.mjs`)은 이 묶음에서 돌리지 않는다. 다음 v1 측정 때 확인한다.

## 시험 결과

시험 담당 `lane5-fixm3-test`, 구현 커밋 `87562b14a` 위. 시험 ID는 감독 결정으로 정본 M3 시나리오 J-T24(`docs/features/settlement.md` §13: '남은 금액이 늘 금액 − 이동 기록 합과 같다')를 쓴다. 정본 J-T24 문장에는 ①② 같은 세부 번호가 없어 겹치는 번호가 없다.

| 계획 이름 | 쓴 이름 | 자리 |
| --- | --- | --- |
| J-T25 M3 ① | J-T24 ① M3 | `services/invariant-checker/test-int/payment-migrated.int.test.ts`(새), `test-int/postgres.ts`에 빈 DB `payment_migrated` |
| J-T25 M3 ② | J-T24 ② M3 | 같은 파일 |
| J-T25 M3 ③ | J-T24 ③ M3 | `services/invariant-checker/test-int/invariants.int.test.ts` |
| J-T25 M3 ④ | J-T24 ④ M3(셋) | `services/invariant-checker/test/report.test.ts` |
| J-T25 M3 ⑤ | J-T24 ⑤ M3(셋: payment만 · 표 없는 DB · 틀린 남은 금액) | `test-int/payment-migrated.int.test.ts` |
| PRF180 M3 ⑥ | 그대로 | `services/payment-svc/test/settlement-migration.test.ts` |
| PRF180 M3 ⑦·⑧ | 그대로 | `services/payment-svc/test-int/settlement.int.test.ts` |
| (감독 요청 (가)) | PRF180 M3 ⑨ | 같은 파일. 저장소의 상계(지급 묶음 트랜잭션)·보증 충당·이동 기록 넣기가 옛 이름 뷰를 거쳐 `receivable_movement`에 쓰이고 저장소 읽기 셋이 표의 행·이동 ID 그대로인지 본다 |

- 감독 요청 (나)는 J-T24 ①②⑤다: payment 마이그레이션을 모두 적용한 DB(`migratePayment`)에서 M3가 SKIPPED 없이 PASS 한 번, 남은 금액을 0으로 둔 행으로 FAIL 한 번(`amount=1000000 remaining=0 moved=500000`), 명령 경계(`runCli`)로 끝 코드 0·0·1과 표준 출력 요약 줄·표준 오류 경고 줄·`invariants.csv`를 본다. 마이그레이터는 경로 글 동적 가져오기로 부른다(검사기 tsconfig에 `allowJs`가 없어 정적 가져오기를 못 한다).
- 고친 기존 시험(기대값만 따라잡음, 이름 그대로): `payment-schema.test.ts` 둘(0028 차례·파일 목록), `payment-grpc.int.test.ts` PRF180 표 목록(`receivable_movement`, 옛 이름 뷰는 relkind `v`라 목록에 없음을 주석으로 적음), `compensation-transfer.int.test.ts` `RESET_SQL`(표 이름), `settlement.int.test.ts` 0016 시험(표 종류까지: 표 둘 `BASE TABLE`, 옛 이름 `VIEW`), `loadtest/test/v1.test.mjs` H2(기대 `['P5','S3']`, M3가 SKIPPED면 '더 M3' 단언을 더함)·재확인1(546줄, 시험 자료를 S3·P5 기대에 맞춤, '더 P3' 단언 그대로), `loadtest/e2e/v1-rehearsal.e2e.mjs` 7줄 주석·132줄(`불변식 SKIPPED: P5·S3(기대 P5·S3,`). 리허설은 kind 무대라 돌리지 않았고 `node --check`만 했다.
- 새 시험 13개(J-T24 아홉: ①②③ 하나씩·④ 셋·⑤ 셋 · PRF180 M3 넷: ⑥⑦⑧⑨), 고친 기존 시험 8개(e2e 하나 포함).
- 구현 트리 결과: 단위 payment-svc 3,228 통과, invariant-checker 25 통과, `node --test "loadtest/test/*.test.mjs"` 538 통과, `pnpm lint` 0, payment-svc·invariant-checker typecheck 0. 통합 invariant-checker 41 통과, payment-svc 28파일 614 통과·2 건너뜀(원래 있던 것). 전체 실행 한 번에 `payment-checkout.int.test.ts` P-T26 하나가 졌으나 그 파일만 다시 돌려 29 통과(앞선 전체 실행에서도 통과, 부하 때 흔들림).
- **구현 결함 후보(감독 결정 필요)**: PostgreSQL 18은 NOT NULL도 이름 있는 제약(`contype n`)으로 적는데, 표 이름을 바꿔도 따라 바뀌지 않아 0028 뒤에 `receivable_move_amount_not_null`·`_id_not_null`·`_kind_not_null`·`_moved_at_not_null`·`_receivable_id_not_null`·`_statement_id_not_null` 여섯이 옛 머리로 남는다(실제 DB에서 확인). 정본 `docs/data.md` §4 ①은 기본 키·CHECK 둘·외래 키 둘·인덱스 하나만 바꾸라고 하므로 PRF180 M3 ⑦의 '옛 머리 이름이 어디에도 없다'는 `contype <> 'n'`으로 정본 범위에 맞췄다(주석에 까닭). 여섯도 바꾸려면 0028에 `RENAME CONSTRAINT` 여섯을 더하고 정본 §4 ①·계획 'SQL 0028'·⑥의 문장 목록·⑦의 조건을 함께 고친다.
- 시험이 정한 것: 표의 칸 차례는 0026이 `id`·`kind`를 뒤에 더해 뷰(`id`부터)와 다르다. ⑦은 칸을 이름·종류로 견준다(앱은 칸 이름으로 읽고 쓴다).

## 리뷰

리뷰 담당 `lane5-fixm3-review`, 시험 커밋 `0bd263d3d` 위. `git diff f0c0206da..HEAD`를 정본 `docs/data.md` §4 '미수금 이동 기록 표 이름 맞추기', `docs/devops.md` §7.1~7.3, `docs/verification.md` §2.5·§3.10과 견주었다. 코드·시험은 고치지 않았다. 높음은 없다.

### 지적

| ID | 등급 | 자리 | 무엇 | 제안 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | 이 파일 '넘기는 것' 156·157줄, `docs/BUILD_ORDER.md` 99·100줄(F-07-6·F-07-7) | 감독은 단계 ②를 F-07-6, ③을 F-07-7에 넘긴다. 그런데 정본(`docs/data.md` §4 ②·③, `docs/devops.md` §7.1 원칙 3)은 ②를 '①이 든 출시의 다음 출시', ③을 '② 출시 7일 뒤 [가정]'로 정한다. 마지막 출시 태그는 `v0.2.0`(2026-11-04)이고 태그 푸시는 소유자 몫(`docs/architecture.md` §8.6 '맡기기')이다. 그래서 F-07-6이 0028과 같은 출시 태그 안에서 저장소를 새 이름으로 바꾸면, 이 계획 '판단 1'이 'ADR이 필요한 예외'라고 한 '한 출시에 ①②'가 조용히 일어난다. F-07-6은 '미수금 상계'를 맡아 이 저장소(`drizzle-settlement-store.ts`)를 고치므로, 구현 담당이 `receivableMoveCompat`을 `receivableMovement`로 바꾸고 싶어질 자리다 | 156·157줄의 가칭을 F-07-6·F-07-7로 바꾸고 시작 조건을 적는다: '0028이 든 출시 태그가 있을 때만 F-07-6이 ②를 한다. 없으면 F-07-6은 `receivableMoveCompat`을 그대로 쓰고 ②를 다음 묶음으로 미룬다(또는 ①②를 한 출시에 합치는 ADR을 먼저 낸다)'. ③도 '② 출시 7일 뒤'를 조건으로 적는다. 기록 담당은 같은 조건을 BUILD_ORDER F-07-6·F-07-7 비고나 `docs/lanes/lane5-cleanup.md`에 한 줄로 남긴다 |
| RV-02 | 중간 | `docs/verification.md` 92줄 ③, `loadtest/run.mjs` 611~652줄(`runInvariants`) | 이 묶음이 정본에 쓴 ③ '측정 실행 도구는 **무대마다** 기대 SKIPPED 목록을 두고 다르면 그 실행을 무효로 한다'를 v0 실행 도구가 따르지 않는다. v0 경로는 끝 코드만 보고 표준 출력을 로그에 남길 뿐이고(이 계획 161줄도 그렇다고 적었다), §3.10에도 v1 목록만 있다. 정본과 코드가 이 커밋부터 어긋난다. 또 v0의 `v0_check`에는 정산 표가 없어, 이제 v0 실행마다 M1~M5 등이 '표 없음' 경고로 표준 오류에 나온다(execFileSync 기본 동작). 이것이 늘 나오는 경고가 되면 사람이 경고를 무시하는 버릇이 들기 쉽다 | 이 묶음에서 정본 문장을 코드에 맞춘다: '③ v1 합본 실행 도구는 기대 SKIPPED 목록을 두고 다르면 그 실행을 무효로 한다(§3.10). v0 실행 도구는 아직 목록을 대조하지 않는다(넘김)'. v0 목록(`v0_check`에 정산 표가 없어 M1~M5, 그 밖은 실측)을 두는 일은 '넘기는 것'의 v0 줄을 따로 할 일로 남긴다. 코드를 고치려면 시험 담당·구현 담당 몫이고 이 묶음 범위를 넘는다 |
| RV-03 | 낮음 | 이 파일 35줄, `docs/BUILD_ORDER.md` 562줄(BAS-060) | 뷰 권한을 넘긴다는 말이 이 계획에만 있다. `security_invoker = true`이면 부르는 앱 역할에 뷰 `receivable_move` **와** 표 `receivable_movement` 둘 다의 권한이 필요하다. BAS-060이 스키마 전체 권한(`GRANT … ON ALL TABLES IN SCHEMA`, `ALTER DEFAULT PRIVILEGES … ON TABLES`)으로 주면 뷰도 들어가지만, core처럼 표마다 목록으로 주면 뷰가 빠져 N-1 앱의 쓰기가 42501로 막힌다. 로컬·CI·데모는 관리 역할이나 DB 소유자(`tools/local/demo-objects.mjs` 665줄)라 지금 시험으로는 보이지 않는다 | 기록 담당이 BAS-060 줄의 'X가 넘긴 것' 꼴로 한 줄을 더한다: 'FIX-invariant-m3가 넘긴 것: payment 앱 DML 역할에 0028의 뷰 `receivable_move` 권한(security_invoker라 표 권한도 함께), 표마다 목록으로 주면 뷰를 넣는다. 단계 ③이 뷰를 지우면 뺀다' |
| RV-04 | 낮음 | 이 파일 '담당 표' | 담당 표에 impl 줄이 없다. 구현 커밋 `87562b14a`은 꼬리말(`Role: impl`, `Agent-Session: lane5-fixm3-impl`)은 있지만 이 파일을 고치지 않았다. F-07-5 계획에는 impl 줄이 있다 | 감독이나 구현 담당이 impl 줄(세션 ID·시작·끝)을 더한다. 리뷰 담당은 자기 줄만 쓴다 |
| RV-05 | 낮음 | `services/payment-svc/test-int/settlement.int.test.ts` PRF180 M3 ⑨ | 저장소가 뷰로 넣는 길 셋은 모두 한 줄 넣기다. 지급 묶음 상계(`drizzle-settlement-store.ts` 554줄)는 미수금이 여럿이면 여러 줄 `VALUES`이고, 이동 ID가 없는 행은 drizzle이 `default`를 넣는다. 자동 갱신 뷰에서 여러 줄 `VALUES`의 `DEFAULT`는 PostgreSQL이 예전 판에서 결함을 고친 길이라 한 번은 실제로 보는 편이 낫다. 18에서는 동작할 것으로 보지만 시험이 확인하지 않는다 | 검증 담당이 한 번 돌려 보거나(미수금 둘을 상계하는 묶음, 또는 뷰에 `id`를 준 행과 안 준 행을 한 문장으로 넣기), 시험 담당이 ⑨에 미수금 하나를 더해 여러 줄 넣기로 만든다. 이 묶음을 막는 지적은 아니다 |
| RV-06 | 낮음 | `services/invariant-checker/src/cli-main.ts` 212~220줄, `test-int/payment-migrated.int.test.ts` ⑤ | 명령 경계 시험은 끝 코드 0·1만 본다. '끝 코드 2(인자·연결·기록 오류) 뜻 그대로'는 코드를 읽어 확인했지만(옛 `main()`의 catch와 같은 분기) 명령 경계 시험이 없다 | `runCli`에 `--out` 없이, 또는 닿지 않는 DB 주소로 부르면 2이고 표준 오류가 `peaket-invariants:`로 시작하며 DB 주소를 싣지 않는다는 시험 하나를 더하면 S7 짝이 된다. 다음 검사기 묶음에서 해도 된다 |
| RV-07 | 낮음 | `services/payment-svc/test-int/settlement.int.test.ts` 553~560줄(⑦의 `contype <> 'n'`), 이 파일 184줄 | PostgreSQL 18 NOT NULL 제약 여섯(`receivable_move_*_not_null`)이 옛 머리로 남는다. **감독 판단('그대로 두고 정리 목록')에 반대하지 않는다.** 근거: ① 앱 코드가 오류의 제약 이름으로 판정하는 곳이 없다(`services/payment-svc/src`에 `.constraint` 비교 없음) ② drizzle snapshot은 NOT NULL 이름을 적지 않아 생성기와 어긋나지 않는다(`db:generate` 바뀐 것 없음) ③ NOT NULL은 인덱스를 쓰지 않는 제약이라 표마다 이름이 겹치지만 않으면 되고, 뷰 `receivable_move`나 다른 표 이름과 부딪치지 않는다 ④ 뒤의 칸 맞추기(`statement_id` 널 허용)는 `ALTER COLUMN … DROP NOT NULL`로 칸을 가리켜 이름에 기대지 않는다. 남는 비용은 사람이 `\d`로 볼 때의 헷갈림과, 나중에 기준선 스키마를 새로 만들면 생길 이름 차이뿐이다 | 정리 목록(`docs/lanes/lane5-cleanup.md`)에 한 줄로 남기고, 단계 ③ 마이그레이션(뷰 지우기)에 `RENAME CONSTRAINT` 여섯을 함께 넣는다. 모든 무대가 PostgreSQL 18이라 그 문장이 다른 판에서 실패할 걱정은 없다. 그때 ⑦의 `contype <> 'n'` 조건과 주석을 지운다 |

### 확인한 것

- **0028 SQL(관점 1)**: 문장 여덟이 계획 'SQL 0028'과 글자까지 같다. `ALTER TABLE … RENAME`·`ALTER INDEX … RENAME`·`RENAME CONSTRAINT`는 시스템 목록만 바꾸고 표 다시 쓰기·제약 다시 검증이 없다. 기본 키는 인덱스 이름을 바꾸면 제약 이름도 따라 바뀌어 `receivable_movement_pkey`가 된다(⑦이 `pg_constraint`로 확인). `DROP`·`ADD CONSTRAINT`·`CREATE INDEX`·`CREATE TABLE`이 없다(⑥). 뷰는 표 하나의 칸 여섯만 고르는 단순 뷰라 자동 갱신이 되고(집계·조인·DISTINCT 없음), 넣지 않은 칸에는 밑 표 기본값(`gen_random_uuid()`·`'OFFSET'`)이 들어간다(⑧). `security_invoker=true`가 `reloptions`에 있다(⑦).
- **단계 ① 앱이 옛 이름만 쓰는지(원칙 3)**: `drizzle-settlement-store.ts`의 다섯 자리(554·1066·1077·1082·1127줄)가 모두 `receivableMoveCompat`(`pgTable('receivable_move')`)이다. 새 `receivableMovement`를 가져다 쓰는 앱 코드는 없다(`schema.ts` 정의뿐). `services/payment-svc/src`에 날 SQL로 두 이름을 쓰는 곳, 뷰에서 못 하는 `TRUNCATE`·`LOCK TABLE`이 없다. purchase-svc·bundle·ops-svc·tools·loadtest에도 두 이름이 없다. compat 파일은 drizzle 표 정의 글로브(`./src/modules/*/adapters/db/schema.ts`) 밖이라 생성기가 보지 않는다(머리 주석에 까닭이 있다).
- **앞 판(N-1) 앱**: 0028 전 코드는 같은 이름 `receivable_move`로 평범한 넣기·읽기만 하므로 뷰로 돈다. 날 SQL로 옛 이름을 읽는 기존 payment 통합 시험(`settlement.int.test.ts` 321·459·520·533줄, `settlement-a1v.int.test.ts` 83줄)이 그대로 통과한다(시험 담당 결과). 시험 쪽 `RESET_SQL`의 `truncate`만 표 이름으로 바꿨는데, 앱 코드에는 `truncate`가 없어 N-1 앱 호환과는 상관없다.
- **권한(관점 2)**: payment 마이그레이션에는 GRANT·RLS가 하나도 없고 이 묶음도 더하지 않는다. 로컬·CI는 관리 역할, 데모는 `payment_app`이 DB 소유자라 뷰·표 모두 소유자 권한으로 닿는다. 운영 역할 나누기는 BAS-060 몫이다(RV-03).
- **snapshot(관점 3)**: 0028 snapshot에서 `receivable_movement`를 `receivable_move`로 되돌려 0027과 견주었다. `id`·`prevId`와 `_meta.tables`의 이름 바꾸기 기록(`"public"."receivable_move" → "public"."receivable_movement"`, drizzle-kit이 이름 바꾸기 때 쓰는 꼴) 말고는 같다. 표 차례도 같고 `views`는 비었다. `prevId`가 0027 `id`다. 이 작업 폴더에서 `node scripts/db-generate.mjs`를 직접 돌렸다: `No schema changes, nothing to migrate`이고 새 파일이 생기지 않았다. journal `when`은 0027보다 크다.
- **검사기(관점 4)**: `exitCode`·CSV·ndjson 형식이 그대로다. `runCli`의 분기는 옛 `main()`과 같다(FAIL 1, 아니면 0, `CliError`·`RecordFormatError`·그 밖의 예외 2, 오류 글에 DB 주소 없음). `cli.ts`는 `runCli` 결과로 `process.exit`만 한다. `report.ts`가 `invariants.ts`·`tables.ts`를 새로 가져오지만 둘은 `report.ts`를 가져오지 않아 순환이 없다. `reason` 글이 그대로라 CSV를 읽는 `skippedProblem`(loadtest)은 영향이 없다.
- **loadtest(관점 4)**: v0 `runInvariants`(641줄)는 끝 코드와 CSV만 쓰고 표준 출력을 로그에 남길 뿐이라 요약 줄이 v0 실행을 깨지 않는다(표준 오류 경고는 RV-02). v1 기대 목록 `['P5','S3']`: 2026-11-11 v1 실행 기록의 SKIPPED가 M1~M5·P5·S3였고 payment 0015·0016이 2026-11-14·15에 들어왔으며, v1 마이그레이션 잡은 payment `scripts/migrate.mjs` 전부를 돌린다(`tools/local/v1-objects.mjs`). 그래서 계획 원인 ⑸의 설명과 맞는다. run.mjs의 notes 글이 상수를 따라가 e2e 단언(`불변식 SKIPPED: P5·S3\(기대 P5·S3,`)과 맞는다.
- **시험(관점 5)**: 감독 요구 (가)는 PRF180 M3 ⑨가 채운다. 저장소의 지급 묶음 상계·보증 충당·이동 기록 넣기가 뷰를 거쳐 표에 쓰이고, 저장소 읽기 셋이 표의 행과 이동 ID까지 같다. 다만 저장소가 compat을 쓰는지 새 이름 표를 쓰는지는 시험으로 가를 수 없고(동작이 같다), 위에서 코드로 확인했다. (나)는 J-T24 ①②⑤가 채운다. `migratePayment`로 만든 DB에서 payment 표 아홉이 `relkind r`이고(목록을 못 박아 S4도 잡는다), M3가 SKIPPED 없이 PASS하며, 남은 금액을 0으로 두면 `amount=1000000 remaining=0 moved=500000` 1건 FAIL이다(되돌림을 더하면 합이 150만 원이 되어 S8을 잡는다). ⑤는 명령 경계에서 표준 출력 줄 수·끝 줄·표준 오류·끝 코드 0·0·1·CSV를 정확한 값으로 본다. 약한 단언은 찾지 못했다(빠진 것은 RV-05·RV-06).
- **돌려 본 것**: invariant-checker 단위 25 통과, payment `test/settlement-migration.test.ts`·`test/payment-schema.test.ts` 85 통과, `node --test loadtest/test/v1.test.mjs` 49 통과, bundle·purchase-svc `tsc --noEmit` 0(payment-svc 원본을 가져다 쓰는 쪽, 시험 담당 결과에 없던 것). 통합 시험은 Docker 잠금을 잡지 않으려고 다시 돌리지 않았다(시험 담당 결과: 검사기 41, payment 614 통과).
- **넘김(관점 7)**: ②·③의 내용(저장소 바꾸기·compat 지우기·시험 SQL 바꾸기, `DROP VIEW`)은 맞다. 시작 조건은 RV-01.

### 이 묶음에서 고칠 것

- RV-01: '넘기는 것' 156·157줄에 F-07-6·F-07-7과 시작 조건(0028이 든 출시 태그 뒤)을 적는다(계획 담당이나 감독). BUILD_ORDER·정리 목록 줄은 기록 담당.
- RV-02: `docs/verification.md` §2.5 ③의 '무대마다'를 v1 실행 도구로 좁히고 v0는 넘김으로 적는다(문서만).
- RV-03·RV-07: 기록 담당이 BAS-060 줄과 `lane5-cleanup.md`에 한 줄씩 남긴다.
- RV-04: 담당 표 impl 줄.
- RV-05·RV-06은 막지 않는다(검증 담당이 RV-05를 한 번 돌려 보면 충분하다).

## 검증

(검증 담당)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-fixm3-plan | claude-opus-5-5 | 2026-11-23T06:40:00+09:00 | 2026-11-23T07:20:00+09:00 |
| test | lane5-fixm3-test | claude-opus-5-5 | 2026-11-23T07:33:00+09:00 | 2026-11-23T08:22:00+09:00 |
| review | lane5-fixm3-review | claude-opus-5-5 | 2026-11-23T08:23:00+09:00 | 2026-11-23T08:40:00+09:00 |
