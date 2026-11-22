# 작업 계획: FIX-payment-int — payment-svc 통합 시험 아홉의 지우는 순서·표 목록을 맞춘다

- **무엇**: `develop`의 CI `node` 잡이 payment-svc 통합 시험 9개로 빨간불이다. ⑴ `test-int/compensation-transfer.int.test.ts`의 J-T28·R-T47 여덟이 시험 사이 표 비우기(`truncate`, 표의 모든 행을 한 번에 지우는 명령)에서 `cannot truncate a table referenced in a foreign key constraint`로 끝난다. ⑵ `test-int/payment-grpc.int.test.ts`의 '마이그레이션과 표 모양' 첫 시험(PRF180)이 표 목록 26개를 기대하는데 실제는 29개다. 이 묶음은 두 시험 파일의 기대를 지금 마이그레이션(DB 구조를 차례로 바꾸는 SQL 파일)에 맞춰 CI를 초록불로 되돌린다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane5-FIX-payment-int`, 가지 `feature/lane5-FIX-payment-int`, 출발점 `origin/develop` `e214bddc5`. 감독 요청과 `docs/lanes/lane3-cleanup.md`의 'BAT-425(R-716) 뒤 CI가 드러낸 것'(커밋 `519ffc748`).
- **정본**: 정산 저장 표 `docs/features/settlement.md` '저장소' 표의 PostgreSQL(payment) 줄(`payout_batch_audit` payment 0025, `guarantee_collection`·`settlement_webhook_receipt` payment 0026), 배상금 미리 지급 J-T28·ADR-0317(같은 문서 §2·시험 표), 결제 표 마이그레이션 `docs/data.md` §4, 묶음 절차 `docs/architecture.md` §8.6. 이 문서는 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **등급·차례**: C(시험 기대값만), 시험만 묶음(`Batch-Kind: test-only`, `docs/architecture.md` §8.6 4): 계획 → 시험(고침) → 리뷰 → 검증 → 기록. **구현 커밋은 없다.** 제품 코드(`services/payment-svc/src/`)·마이그레이션·계약은 고치지 않는다.

## 원인

**시험 결함이다(제품 결함 아님).** 마이그레이션 0025·0026은 정산 정본(`docs/features/settlement.md` 저장소 표, BAT-625·BAT-630)대로 표를 더했고, 두 시험이 그 뒤를 따라가지 못했다.

| # | 실패 | 실제 원인 | 근거 |
| --- | --- | --- | --- |
| ⑴ | J-T28 여덟(`beforeEach` 93줄, ② 시험 안 177줄) | PostgreSQL은 외래키(다른 표의 행을 가리키는 칸)로 가리켜지는 표를 비울 때, 가리키는 표도 같은 `truncate` 문에 넣어야 한다. 0026(BAT-630)이 `guarantee_collection.receivable_id → partner_receivable` 외래키를 더했는데 시험은 `compensation_transfer, receivable_move, partner_receivable`만 비운다. `partner_receivable`을 가리키는 외래키는 지금 둘(`receivable_move`·`guarantee_collection`, 0016·0026)뿐이고 `compensation_transfer`를 가리키는 외래키는 없다 | `migrations/0026_settlement_payout_agency.sql` 27줄, `0016_receivables.sql` 26줄 |
| ⑵ | PRF180 표 목록(173줄) | 0025(BAT-625)가 `payout_batch_audit`, 0026(BAT-630)이 `guarantee_collection`·`settlement_webhook_receipt`를 더했는데 기대 목록은 0024까지의 26개다. CI 차이에 정확히 이 셋만 더 있다 | `0025_payout_batch_approval.sql` 1줄, `0026_…` 1·17줄, CI 로그 diff |

- **정정**: `lane3-cleanup.md`의 '`compensation_transfer` 판을 `0025`로 기대하는데 지금은 `0028`'은 Vitest 출력 `[ 'compensation_transfer', …(28) ]`·`…(25)`(첫 원소 뒤 남은 원소 수)를 판 번호로 읽은 것이다. 마이그레이션은 0026까지이고, 실제 차이는 표 29개 대 26개다.
- **정본 문서의 뒤처짐(넘김, 이 묶음 밖)**: 세 표와 `seller_kyc.toss_seller_id`·`toss_seller_status`는 `docs/features/settlement.md`에는 있지만 `docs/data.md` §2 ERD(표 관계 그림)에는 없다. payment의 다른 표는 모두 ERD에 있다. 마이그레이션이 정본을 어긴 것이 아니라 BAT-625·BAT-630이 `data.md` ERD를 함께 고치지 않은 문서 누락이다. 또 ERD의 이동 기록 표 이름은 `receivable_movement`인데 마이그레이션(0016부터)은 `receivable_move`다(이 묶음 전부터 있던 차이). 둘 다 문서 묶음에서 `data.md`를 고친다. 이 묶음의 실패와는 무관하다(PRF180 칸 대조 `COLUMNS`는 세 표를 보지 않는다).

## 실패 확인

이미 `develop` CI에서 실패했다. 시험 담당은 고치기 전 로컬에서 두 파일을 한 번 돌려 같은 9개 실패를 이 표에 덧붙인다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| CI 실행 `45038336541`(`c27097d6c`, 2026-11-23 00:26 KST) `node / node` 잡의 `pnpm --filter @peaket/payment-svc test:integration` | **2파일 9시험 실패**(27파일 중 25 통과, 585 통과·2 건너뜀) | ⑴ `compensation-transfer.int.test.ts:93` `cannot truncate a table referenced in a foreign key constraint` 여덟, ⑵ `payment-grpc.int.test.ts:173` 표 목록 차이(`guarantee_collection`·`payout_batch_audit`·`settlement_webhook_receipt` 더 있음) 하나 |
| 그 뒤 `develop` 실행(`45040437883`·`45045323160`·`45048066063` 초록, `45054926121`·`45055032034` 도는 중) | 문서만 바꾼 커밋이라 `node` 잡을 건너뜀 | 실패는 `develop`에 그대로 남아 있다 |
| 시험 담당 로컬(계획 커밋 `32f1e9a40` 트리, 고치기 전, 2026-11-23 04:16) `pnpm --filter @peaket/payment-svc test:integration test-int/compensation-transfer.int.test.ts test-int/payment-grpc.int.test.ts` | **2파일 9시험 실패, 94 통과**(103개) | CI와 같다. ⑴ J-T28·R-T47 여덟이 `cannot truncate a table referenced in a foreign key constraint`, ⑵ PRF180 표 목록 차이가 정확히 `+ guarantee_collection`·`+ payout_batch_audit`·`+ settlement_webhook_receipt` 셋 |

## 고칠 곳

| # | 파일·줄 | 바꿀 것 |
| --- | --- | --- |
| 1 | `services/payment-svc/test-int/compensation-transfer.int.test.ts` 93줄(`beforeEach`) | `truncate compensation_transfer, receivable_move, guarantee_collection, partner_receivable`. `cascade`는 쓰지 않는다(새 외래키가 생기면 조용히 다른 표까지 비우지 않고 드러나게 한다) |
| 2 | 같은 파일 177줄(J-T28 ② 상태별 고리 안) | 1과 같은 목록. 두 곳이 같은 글을 되풀이하므로 파일 위에 상수 하나(예 `RESET_SQL`)로 묶어 두 곳에서 쓴다 |
| 3 | `services/payment-svc/test-int/payment-grpc.int.test.ts` 173줄(PRF180 기대 표 목록) | `relname` 차례 그대로 `'guarantee_collection'`(`event_pg_config` 뒤), `'payout_batch_audit'`(`payout_batch` 뒤), `'settlement_webhook_receipt'`(`settlement_statement_audit` 뒤)를 더해 29개 |

- 시험 이름(ID `J-T28`·`R-T47`·`PRF180`…와 세부 번호)은 바꾸지 않는다. 장부·대조 스크립트가 이름으로 찾는다. PRF180 이름의 '(0000~0021)'은 낡은 글이지만 이름을 바꾸지 않는다.
- 단언 자체(행 수·상태·미수금 칸)는 바꾸지 않는다. 시험이 지우는 표와 기대 목록만 따라잡는다.

## 확인 명령

Docker가 필요하다. 잠금을 잡고 돌린 뒤 놓는다(잠금이 비어 있지 않으면 기다린다. 갈래 안에서 한 담당만 잡는다).

```bash
bash D:/ticketpass-locks/lock.sh take docker lane5-FIX-payment-int
pnpm exec turbo run build --filter=@peaket/payment-svc^...      # 의존 패키지 dist(CI와 같은 순서)
pnpm --filter @peaket/payment-svc test:integration test-int/compensation-transfer.int.test.ts test-int/payment-grpc.int.test.ts
pnpm --filter @peaket/payment-svc test:integration                # 회귀: 27파일 전부(검증 담당)
bash D:/ticketpass-locks/lock.sh drop docker lane5-FIX-payment-int
pnpm --filter @peaket/payment-svc typecheck
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
```

- 통과 기준: 두 파일의 9개를 포함해 모두 통과, payment-svc 통합 27파일 실패 0, typecheck·lint 0, doc-check 오류 0, roles-check가 이 묶음을 '시험만'으로 센다.

## 틀린 구현 표본(검증 담당용)

| # | 넣을 틀린 것 | 잡을 검사 |
| --- | --- | --- |
| S1 | 1의 목록에서 `guarantee_collection`을 뺀다 | J-T28 여덟이 `cannot truncate …`로 실패 |
| S2 | 0026의 `settlement_webhook_receipt`를 다른 이름으로 만든다(또는 정본에 없는 표를 만드는 새 마이그레이션을 더한다) | PRF180 표 목록 시험 실패 |
| S3 | 177줄(고리 안 비우기)을 지운다 | J-T28 ② 상태별 시험이 둘째 상태에서 `toHaveLength(1)`·미수금 0행 단언으로 실패 |

## 넘기는 것

- **`docs/data.md` ERD 누락**: `payout_batch_audit`·`guarantee_collection`·`settlement_webhook_receipt`·`seller_kyc.toss_seller_id`·`toss_seller_status`를 ERD에 더하고 `receivable_movement`/`receivable_move` 이름 차이를 정한다. 문서 묶음 몫이다(원인 절).
- **세 표의 칸 대조**: PRF180 `COLUMNS`에 세 표를 더할지는 이 묶음에서 하지 않는다. 동작은 `test-int/settlement.int.test.ts`(BAT-625·BAT-630)가 본다.
- **새 시험 ID·단계**: 만들지 않는다. BUILD_ORDER 단계·wbs 상태 변화도 없다. 기록에서 `lane3-cleanup.md`의 해당 줄을 닫는다.

## 시험 결과

시험 담당(lane5-fixint-test)이 '고칠 곳' 1~3대로 두 파일만 고쳤다. `compensation-transfer.int.test.ts`는 파일 위 상수 `RESET_SQL`(`truncate compensation_transfer, receivable_move, guarantee_collection, partner_receivable`, `cascade` 없음) 하나를 93·177줄 두 곳에서 쓴다. `payment-grpc.int.test.ts`의 PRF180 기대 목록에 세 표를 `relname` 차례 자리에 더해 29개다. 시험 이름과 다른 단언(행 수·상태·미수금 칸·적용 기록 수)은 그대로다.

| 검사 | 결과 | 까닭 |
| --- | --- | --- |
| 두 파일(위 '실패 확인'과 같은 명령, 고친 뒤) | **2파일 103시험 통과**(실패 0) | 9개가 모두 초록. 다른 94개는 그대로 통과 |
| `pnpm --filter @peaket/payment-svc test:integration` 1회째 | 27파일 중 9파일 15시험 실패, 574 통과·2 건너뜀 | 이 묶음과 무관한 환경 문제. ⑴ `merch-path-e2e`가 core-svc 원본이 읽는 `@peaket/search-normalize`의 `dist`가 이 작업 폴더에 없어 파일째 실패(`payment-svc^...` 빌드에 들지 않음), ⑵ 나머지 14개는 서킷·전파·조회 시간 한도(`DEADLINE_EXCEEDED`, 1400ms 안, Redis 마감 100ms)로, 같은 때 기계 CPU가 94~100%였다. 두 고친 파일은 이 실행에서도 통과 |
| `pnpm exec turbo run build --filter=@peaket/search-normalize` 뒤 전체 2회째 | **26파일 통과, 1시험 실패**, 593 통과·2 건너뜀(596) | 남은 하나는 `purchase-path-e2e` P-T25의 준비 단계(`openSale`) `RedisDeadlineError: Redis 호출이 마감 100ms를 넘겼다`(CPU 100%). 1회째에는 통과한 시험이다 |
| `purchase-path-e2e.int.test.ts`만 다시 | **17 통과·1 건너뜀**(실패 0) | 부하 없이 통과. 시간 한도·재시도는 고치지 않았다 |
| `pnpm exec turbo run typecheck --filter=@peaket/payment-svc` | 7작업 성공 | 오류 0 |
| `pnpm lint` | 끝 코드 0 | 오류 0 |

- 시험 컨테이너는 실행마다 스스로 지워졌고(`docker ps -a`에 남은 것 없음) 잠금은 04:16~04:27 쥐고 놓았다.
- 검증 담당에게: 전체 통합 시험은 기계가 한가할 때 돌린다. CI 기준선(`45038336541`)은 이 둘 밖 실패가 없었다.

## 리뷰

리뷰 담당(lane5-fixint-review)이 출발점 `e214bddc5`부터 `10933df92`까지의 차이(계획 파일과 시험 두 파일)를 마이그레이션 0000~0026 전부와 대조했다. **높음·중간 지적은 없다.** 이 묶음은 그대로 검증으로 넘긴다. 아래 RV-02는 이 묶음 밖에서 찾은 것이라 넘긴다.

| ID | 등급 | 자리 | 지적 | 제안 |
| --- | --- | --- | --- | --- |
| RV-01 | 낮음 | `payment-grpc.int.test.ts` 170줄 PRF180 시험 이름 '(0000~0021)' | 마이그레이션은 0026까지라 이름 속 범위가 낡았다. 계획이 장부 대조 때문에 일부러 두었고 단언은 폴더의 SQL 파일 수를 세므로 동작에는 영향이 없다 | 이 묶음에서는 그대로 둔다. 시험 이름을 바꿀 일이 생기면 장부 이름과 함께 고친다 |
| RV-02 | 중간(묶음 밖, 넘김) | `services/invariant-checker/src/tables.ts` 35줄·`src/invariants.ts` 45줄(M3)·`test-int/postgres.ts` 80줄 | 불변식 검사기가 이동 기록 표를 `receivable_movement`로 찾는다. 실제 payment 마이그레이션(0016부터)은 `receivable_move`라서 실제 DB에 대면 M3('미수금 남은 금액 = 금액 − 이동 기록 합')는 표가 없다며 SKIPPED가 된다(`invariants.ts` 2줄 규칙). 검사기 시험은 손으로 만든 `receivable_movement` 표를 써서 이 차이를 못 본다. 계획 '원인' 절의 ERD 이름 차이(`data.md`)와 같은 뿌리다 | 계획 '넘기는 것'의 `data.md` 이름 정하기와 함께 묶어, 정한 이름으로 검사기 표 목록·M3 SQL·시험 스키마를 맞춘다. 이 묶음(시험만, payment-svc)에서는 고치지 않는다 |

확인한 것:

- **외래키 전부를 덮는가**: `migrations/*.sql` 전체에서 `REFERENCES`는 14개다. `partner_receivable`을 가리키는 것은 `receivable_move`(0016 26줄)·`guarantee_collection`(0026 27줄) 둘뿐이고, `compensation_transfer`·`receivable_move`·`guarantee_collection`을 가리키는 외래키는 없다(0024는 외래키를 만들지 않는다). 그래서 `RESET_SQL`의 네 표는 닫힌 묶음이고 `cascade` 없이 비울 수 있다. `receivable_move → settlement_statement`(0016 27줄)는 가리키는 쪽이 비워지는 것이라 문제없다.
- **표 목록이 마이그레이션과 같은가**: `CREATE TABLE`은 0000~0026에 29개이고(`DROP TABLE`·`RENAME`은 없다) 기대 목록 29개와 이름이 하나하나 같다. `outbox`의 분할 조각은 `relname !~ '^outbox_p'`로 빠진다. 더한 세 자리는 `order by relname`(바이트 차례) 그대로다: `event_pg_config` < `guarantee_collection` < `outbox`, `payout_batch` < `payout_batch_audit` < `pg_switch`, `settlement_statement_audit` < `settlement_webhook_receipt` < `statement_dispute`.
- **단언이 약해지지 않았나**: 차이는 truncate 글 두 곳을 상수 하나로 바꾼 것과 기대 배열에 세 이름을 더한 것뿐이다. `toEqual` 전체 비교·행 수·상태·미수금 단언과 시험 이름은 그대로다. `cascade`를 쓰지 않아 새 외래키가 생기면 다시 실패로 드러난다. J-T28 ② 고리 안 비우기(177줄)도 남아 있어 상태별 독립성이 유지된다.
- **다른 test-int에 같은 꼴 결함이 있나**: `grep -rn "truncate" services/payment-svc/test-int` 23곳을 대조했다. `payment`을 비우는 곳은 모두 그것을 가리키는 `payment_event`·`payment_confirm_job`·`payment_cancel`(0000 51·52줄, 0021 20줄)을 함께 넣는다. `payment-reconciliation`은 `reconciliation_diff`·`reconciliation_run`을 함께 넣고 `cascade`까지 쓴다. `event_pg_config`·`pg_switch`·`payment_entry_*`·`payment_channel_limit`·`payment_pg_channel_observed`·`webhook_receipt`·`outbox`는 가리켜지지 않는다. 숨은 결함은 없다. 표를 직접 세는 다른 곳(`compensation-transfer` 203줄·`payment-cancel-refund-account` 220줄)은 표를 그때그때 읽어 오므로 새 표에 따라 깨지지 않고, `settlement.int.test.ts` 121·194줄은 이름을 정해 고른다.
- **원인 판단(시험 결함, 제품 아님)**: 맞다. 0025는 `payout_batch_audit`, 0026은 `guarantee_collection`·`settlement_webhook_receipt`와 `guarantee_collection → partner_receivable` 외래키를 더했고, 시험 두 파일만 그 뒤를 따라가지 않았다. 제품 코드·마이그레이션·계약에는 차이가 없다(차이는 계획 파일과 `test-int` 두 파일뿐이라 '시험만' 묶음 조건에 맞다). '정정'의 Vitest `…(28)` 읽기 풀이도 표 29개 대 26개와 맞는다.

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-fixint-plan | claude-opus-5-5 | 2026-11-23T03:28:00+09:00 | 2026-11-23T03:42:00+09:00 |
| test | lane5-fixint-test | claude-opus-5-5 | 2026-11-23T03:37:00+09:00 | 2026-11-23T04:30:00+09:00 |
| review | lane5-fixint-review | claude-opus-5-5 | 2026-11-23T04:30:00+09:00 | 2026-11-23T04:40:00+09:00 |
