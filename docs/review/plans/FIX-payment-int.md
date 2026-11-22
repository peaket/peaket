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

## 리뷰

## 검증

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane5-fixint-plan | claude-opus-5-5 | 2026-11-23T03:28:00+09:00 | 2026-11-23T03:42:00+09:00 |
