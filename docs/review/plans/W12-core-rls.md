# 작업 계획: W12-core-rls(판매자 표 `promoter` 행 보안·AZ-T5 고침·R165-1 표 준비)

- **무엇**: core-svc 통합 시험 실패 셋을 고친다. 둘(AZ-T5)은 보안 결함이다. 파트너 DB 역할 `core_partner`가 다른 파트너의 판매자 행(상호·연락처·사업자등록번호)을 읽고 고칠 수 있다. 하나(R165-1)는 시험의 표 준비 결함이다. 감독 결정(2026-11-22): 보안 높음, A 등급처럼 한다(시험 먼저, 틀린 구현 검사는 항목마다, 리뷰는 보안 관점). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-b171`, 가지 `feature/lane2-W12-core-rls`, 출발점 `origin/develop` `650ef80e0`. 2026-11-22 계획 담당(세션 `lane2-w12corerls-plan`)이 썼고 제품·시험 코드는 쓰지 않았다. 계획을 쓰는 동안 develop은 `5ede68cde`까지 갔지만 core-svc 마이그레이션의 마지막은 그대로 `0034_sale_review_request`(journal `when` 1795118255889)다. 마이그레이션 번호 **0040**은 감독이 나눴다(`docs/lanes/coord.md` '번호 나누기(웨이브 12)' 2026-11-22 더 나눔).
- **근거 실행**: GitHub Actions 44919441525(PR #51, 머리 `9d2ace536`)의 `node / node` 잡. `gh run view 44919441525 --repo peaket/peaket --log-failed`의 `node / node` 잡 부분으로 봤다. core-svc 통합 시험 477개 가운데 3개가 실패했다(아래 1).
- **차례**: 시험 먼저다. 계획 → 시험(구현 전 트리에서 실패 확인) → 구현 → 리뷰(보안 관점) → 검증(틀린 구현 16개) → 기록. 이 계획 커밋에는 차례 꼬리말(`Batch-Order`)을 달지 않는다(docs/architecture.md §8.6 '역할 나누기'의 '차례').
- **정본**: [ADR-0327](../../adr/0327-sale-review-request-and-sale-open.md) 결정 1·11과 **결정 13**(이 계획 커밋에서 더함), [ADR-0241](../../adr/0241-core-svc-partner-row-security.md) 결정 1·3·4·7과 '다른 선택지'(상태 줄 보충을 이 커밋에서 더함), [ADR-0320](../../adr/0320-promoter-contract-terms-approval-and-freeze.md) 결정 8, [ADR-0200](../../adr/0200-event-detail-public-contract.md)(회차 상세의 판매자 신원정보), [authz-matrix](../../security/authz-matrix.md) §3.3·§5.3·§7 AZ-T5, [data.md](../../data.md) `promoter`, [settlement ASVS](../../security/asvs/settlement.md) 8.4.1.

## 감독에게

1. **로컬 재현은 하지 못했다.** Docker 잠금을 `lane2-W12-dt50`이 쥐고 있었다(`lock.sh who docker`, 01:00:32부터, 01:13·01:28에 다시 봄). 01:36에 비었을 때 `take`를 했지만 같은 때 `lane4-BAT-355`가 먼저 잡아 1로 끝났다. 지시대로 기다리지 않고 코드 읽기와 위 CI 로그로 원인을 확인했다. 그래서 이 계획 담당은 컨테이너를 띄우지 않았고 잠금을 잡지도 놓지도 않았다(설계 안의 실패 단언은 아래 2 'PostgreSQL 동작'의 문서 근거와 CI 로그의 실제 값으로 세웠다). 시험 담당의 실패 확인(아래 6)이 이 묶음의 첫 로컬 실행이다.
2. **같은 문제가 다른 표에 있다(보안 높음 후보, 이 묶음에는 넣지 않음).** `idempotency_record`에 행 보안이 없다. 세 역할이 모든 작업의 기록을 읽고 고친다. `core_partner`는 0004에서, `core_app`은 0027에서 읽기·넣기·고치기를 받았고, `core_ops`는 0033에서 지우기까지 받았다. 그래서 파트너 경로의 쿼리 하나가 잘못되면 팬 굿즈 결제 시도의 재생 응답을 읽거나 바꿀 수 있다. `START_MERCH_PAYMENT`의 `result_ref`가 결제창 값 JSON(금액, 결제 뒤 돌아올 주소)이다(`services/core-svc/src/modules/shop/application/merch-payment.ts` 100행, `adapters/db/drizzle-merch-orders.ts` 464행). 돈 길(A 대상)이고 정할 것(작업과 역할의 짝)이 있어 새 묶음을 추천한다. 문안은 아래 11.
3. **정리 목록 후보(보안 높음 아님, ADR-0283 결정 6)**: 기록 담당이 `docs/lanes/lane2-cleanup.md`에 한 줄씩 적기를 권한다.
   - (가) 중간: `core_app`이 `promoter`를 표 단위로 읽는다(0004 `GRANT SELECT ON ALL TABLES`). 그래서 `commission_rate_bp`·`pending_contract_approval_id`도 읽힌다. 팬 경로 코드는 판매자 정보 칸만 읽는다(`drizzle-catalog-repository.ts` 109행의 `promoter` 기본 객체). 칸 단위로 좁힐 후보다. 판매 승인된 공연이 있는 판매자만 보이게 할지도 함께 본다.
   - (나) 중간: `production_artist`·`search_alias`는 `core_partner` 넣기만 있고 행 보안이 없다(ADR-0241 결정 4의 설계). 그래서 DB 수준에서는 다른 파트너 공연에 출연진·다른 이름을 붙일 수 있다.
   - (다) 낮음: `assertDatabaseRole`의 소유자 확인이 `production`·`event` 두 표만 본다(`database-role.ts` 24행). 행 보안을 켠 표 전체로 넓힐 후보다.
   - (라) 낮음: R165-1 표 준비를 SQL로 바꾸면(아래 1.3) BAT-615가 그 시험 때문에 둔 그림자 표 객체 `promoterContractState`·`eventContractState`(`schema.ts` 34~45·355~367행)를 기본 객체로 합칠 수 있다.
   - (마) 낮음: `requestReview`가 판매자 행을 정확히 1개 고쳤는지 보지 않는다(`drizzle-sale-store.ts` 577~591행). 행 보안이 잘못 걸리면 판매자 정보가 조용히 저장되지 않는다. 이 묶음에서는 시험 ④와 기존 `sale-review-db.int.test.ts`가 그 경우를 잡는다.
4. **마이그레이션 번호와 `when`**: 0040의 `when`은 구현 때 develop의 마지막 `when`보다 커야 한다. 지금 마지막은 1795118255889다. 웨이브 12 표에서 0035~0036은 갈래 3, 0037~0039는 갈래 5 몫이다. 그쪽이 0040보다 뒤에 합쳐지면 번호와 `when`을 0040 위로 다시 매겨야 한다(PROGRESS 턴 규칙 '갈래 사이 번호 나누기'). 단위 시험 `test/migrations-journal.test.ts`가 `when` 차례를 본다.
5. **새 ADR은 만들지 않았다.** 결정 1·11이 이미 이 경로의 DB 권한을 정한다. 그래서 빈칸(행 보안)을 ADR-0327 결정 13으로 보충했다. ADR 0338은 쓰지 않는다. 정본 고침은 아래 4 표 끝에 있다.

## 계획

### 1. 재현 결과와 원인

#### 1.1 CI에서 본 것(실행 44919441525, core-svc 통합 시험 3/477 실패)

| 시험 | 실패 모양 | 뜻 |
| --- | --- | --- |
| `rls.int.test.ts` 99행 '…코드가 쓰지 않는 표는 읽지 못한다(판매자 연락처, …)' | 101행 `tx.select({ id: promoter.id }).from(promoter)`(테넌트 A)가 42501로 거절되지 않고 **2행**(A·B)을 돌려줌 | 파트너가 남의 판매자 행까지 본다 |
| `rls.int.test.ts` 118행 '…판매자 표를 고칠 권한이 없다' | 120행 `tx.update(promoter).set({ legalName: 'x' })`(테넌트 A)가 거절되지 않고 `rowCount: 2` | 파트너가 **A와 B의 상호를 함께 고쳤다** |
| `search-read-model.int.test.ts` 525행 R165-1 '…서버가 뜰 때의 따라잡기…' | 559행 `d.db.insert(production)`이 `42703 column "sale_submitted_at" of relation "production" does not exist` | 0022까지만 올린 DB에 지금 모양의 Drizzle 객체로 넣었다 |

#### 1.2 AZ-T5 원인(감독 확인과 같음)

- BAT-616의 `services/core-svc/migrations/0034_sale_review_request.sql` 21행이 `GRANT SELECT ON "promoter" TO core_partner`를, 23행이 판매자 정보 8칸의 `GRANT UPDATE`를 준다. 이것은 ADR-0327 결정 1(요청이 판매자 정보를 쓴다)·결정 4 마지막 줄(파트너 현황이 판매자 정보를 싣는다)·결정 11의 의도된 권한이다.
- 그런데 `promoter`에는 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)이 없다. 0004는 `production`·`event`에만, 0033은 `promoter_contract`에만 켰다(`grep "ENABLE ROW LEVEL SECURITY" migrations/*.sql`로 21개 표를 봤고 `promoter`는 없다). 그래서 권한을 주는 순간 모든 행이 열렸다.
- 이 시험 둘은 0034 이전 설계(ADR-0241 결정 4 '판매자 연락처를 읽지 못한다')를 단언하고 있었다. 이 묶음은 기능(ADR-0327)을 살리고 범위를 자기 행으로 좁힌다. 그래서 단언을 '남의 판매자 행은 읽지도 고치지도 못한다, 자기 행의 판매자 정보 칸은 고친다'로 바꾼다.

#### 1.3 R165-1 원인과 고칠 쪽: **시험 준비 쪽이다**

- 이 시험은 저널을 `0023_search_read_model_tables` 앞에서 자른 사본으로 0022까지만 올린다(534~538행). 그 DB에 549~566행이 **지금 모양의 Drizzle 표 객체**로 행을 넣는다. Drizzle의 INSERT는 객체에 정의된 칸을 모두 적는다(값이 없으면 `default`). CI 로그의 실패 문장에도 `"sale_submitted_at", "rejection_reason"`이 들어 있다.
- 0034가 `production` 기본 객체에 두 칸(`schema.ts` 103·105행)을 더하자 0022 모양의 DB에서 INSERT가 깨졌다. BAT-615는 같은 문제를 피하려고 `promoter`·`event`의 새 칸을 그림자 객체로 뺐다(`schema.ts` 36·357행 주석이 이 시험을 이름으로 든다). BAT-616은 그 꼴을 따르지 않았다.
- **판정**: 제품 코드와 0034는 정본(ADR-0327 결정 11)대로다. 결함은 옛 DB 모양을 흉내 내는 시험이 지금 모양의 객체를 쓰는 데 있다. 그림자 객체를 하나 더 두는 구현 쪽 고침은 칸이 늘 때마다 같은 덫을 다시 만든다. 그래서 **시험 담당**이 0023 앞 표 준비를 그때 있던 칸만 적은 SQL로 바꾼다. `promoter-contract.int.test.ts` 71~91행이 같은 꼴(0033 앞 DB에 칸을 적은 SQL)이다. **구현 담당은 R165-1 때문에 아무것도 고치지 않는다.** `production` 그림자 객체도 만들지 않는다.

### 2. 정책 설계(정본: ADR-0327 결정 13)

0040이 다음을 차례로 한다. 정책 이름·역할·식은 결정 13을 그대로 쓴다. 0033처럼 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`로 다시 돌려도 같은 결과가 나오게 쓴다.

1. `REVOKE SELECT ON "promoter" FROM core_partner`(0034의 표 단위 읽기를 거둔다).
2. `GRANT SELECT ("id", 판매자 정보 8칸) ON "promoter" TO core_partner`. 8칸은 0034 23행이 고치기를 준 칸과 같다. 0034의 칸 고치기 권한은 그대로 둔다. 1과 2의 차례를 바꾸지 않는다. 표 단위 REVOKE는 같은 종류(SELECT)의 칸 권한까지 거둔다(PostgreSQL REVOKE 문서). UPDATE 칸 권한은 다른 종류라 남는다.
3. `ALTER TABLE "promoter" ENABLE ROW LEVEL SECURITY`. **FORCE는 걸지 않는다.**
4. 정책 넷:

| 정책 | 역할 | 명령 | USING(어느 기존 행이 보이고 고쳐지는가) | WITH CHECK(고친 뒤 새 행이 통과해야 할 조건) |
| --- | --- | --- | --- | --- |
| `promoter_partner_self_read` | `core_partner` | SELECT | `id`가 그 트랜잭션 테넌트(`app.tenant_id`, 빈 문자열은 NULL)인 행만. 테넌트가 없으면 0건 | — |
| `promoter_partner_self_update` | `core_partner` | UPDATE | 위와 같은 식 | 위와 같은 식(고친 뒤에도 자기 행이어야 한다) |
| `promoter_ops` | `core_ops` | ALL | 참(모든 판매자) | 참 |
| `promoter_app_read` | `core_app` | SELECT | 참(모든 판매자, 읽기만) | — |

- **식의 뜻**: `id = nullif(current_setting('app.tenant_id', true), '')::uuid`는 0004 `production_partner_tenant`와 같은 식이고, `promoter_id` 자리에 `id`가 온다. 판매자 표는 행의 `id`가 곧 테넌트 값이다(authz-matrix §3.3). 값을 걸지 않으면 NULL이라 0건이다. 앞 트랜잭션이 걸었던 연결은 빈 문자열을 돌려주므로 `nullif`로 NULL로 바꾼다(authz-matrix §5.3. 없으면 `uuid` 변환 오류 22P02).
- **읽기와 고치기를 나눈 까닭**: 파트너에게 필요한 것은 읽기·고치기뿐이다. `FOR ALL`로 두면 넣기·지우기 권한이 실수로 더해질 때 행 보안이 막지 못한다. 정책이 없는 명령은 행 보안이 기본으로 거부한다.
- **PostgreSQL 동작에서 시험·검증이 알아야 할 것**(PostgreSQL 18 CREATE POLICY 문서의 '명령별 적용 정책' 표):
  - UPDATE가 칸을 읽으면(WHERE·RETURNING·SET 식) 읽기 정책도 함께 걸린다. 그래서 `requestReview`의 `UPDATE … WHERE id = 테넌트`는 읽기·고치기 두 정책을 모두 지나야 1행이다. 반대로 고치기 정책의 USING이 틀렸는지 보려면 **WHERE도 RETURNING도 없는 UPDATE**로 시험해야 한다. 그래야 읽기 정책이 가리지 않는다(아래 5의 ③).
  - UPDATE 정책에 WITH CHECK가 없으면 USING이 새 행 검사에도 쓰인다. 게다가 파트너는 `id` 칸을 고칠 권한이 없다. 그래서 WITH CHECK를 빼도 행동은 같다. 결정 13은 앞으로 권한이 넓어질 때를 막으려고 WITH CHECK를 적게 했고, 시험 ⑦이 카탈로그(`pg_policies`)로 본다.
  - 외래 키 검사(`production`·`event`·`promoter_contract` → `promoter`)는 행 보안을 건너뛴다. 공연 등록 같은 파트너 넣기는 그대로 돈다.
  - 표 소유자와 슈퍼유저는 정책을 건너뛴다(FORCE가 없을 때). 통합 시험의 `admin` 연결은 슈퍼유저라 시드를 그대로 넣는다.
- **칸 단위 읽기가 맞는 까닭**: 파트너 경로가 `promoter`를 읽는 곳은 `partnerReview`(`drizzle-sale-store.ts` 255~313행: `pr.id`와 8칸)와 `requestReview`의 WHERE(`id`) 둘뿐이다. `verified_at`(운영자 확인 시각)은 파트너 현황 응답에 없다(authz-matrix §4.1 '판매 승인' 행). `commission_rate_bp`·`pending_contract_approval_id`는 계약 값이고, 파트너는 `promoter_contract`로 읽는다(ADR-0320 결정 8, `drizzle-commission-rate.ts`).
- **이전 판 코드(N-1)와 함께 돌기**: 쿼리를 바꾸지 않으므로 배포 창 동안 0034 코드도 0040 스키마에서 그대로 돈다. 칸과 표 모양은 그대로다.

### 3. 다른 역할 영향(지금 `promoter`를 읽고 쓰는 코드 경로 전부)

`grep`으로 `services/core-svc/src`·`scripts`의 `from(promoter)`·`promoterContractState`·`join promoter`·`from promoter`·`into promoter`를 모두 찾았다.

| 역할(연결) | 코드 | 하는 일 | 0040 뒤 |
| --- | --- | --- | --- |
| `core_app`(팬 경로 `PEAKET_DATABASE_URL`) | `drizzle-catalog-repository.ts` 102~110행 `findEventSummary` | 회차⋈공연⋈판매자 **내부 결합**, 판매자 신원정보(ADR-0200) | `promoter_app_read`로 모두 보인다. 정책이 빠지면 결합이 0행이라 회차 상세가 404가 된다(아래 M12) |
| `core_partner`(`PEAKET_PARTNER_DATABASE_URL`, 테넌트 트랜잭션) | `drizzle-sale-store.ts` 255~313행 `partnerReview` | 공연⋈판매자, `p.promoter_id = 테넌트` | 자기 행이라 그대로 |
| `core_partner` | 같은 파일 577~591행 `requestReview` | `UPDATE promoter SET 8칸 WHERE id = 테넌트` | 읽기·고치기 정책을 지나 1행 |
| `core_ops`(`PEAKET_OPS_DATABASE_URL`) | 같은 파일 316~361행 `opsReviews`, 364행부터 `opsReviewDetail` | 모든 테넌트의 공연⋈판매자 | `promoter_ops`로 그대로 |
| `core_ops` | `drizzle-promoter-store.ts` 89행 `list`, 117행 `detail`, 152행 `terms`, 167행 `create`(넣기·수수료율), 198~245행 `reserveChange`(`SELECT … FOR UPDATE`), 247행 `clearPending`, 261행 `applyChange`, 298행 `summary` | 파트너사 목록·상세·등록·계약 변경 | `promoter_ops`(FOR ALL)로 그대로. `FOR UPDATE` 잠금도 고치기 정책 USING(참)을 지난다 |
| 표 소유자·부트스트랩 | `scripts/seed-demo.mjs` 47·49행(`PEAKET_BOOTSTRAP_DATABASE_URL`), `scripts/fill-search.mjs` 66행, 0033 백필 | 판매자 넣기·읽기 | FORCE가 없어 그대로 |
| `core_maintenance`·`core_search` | 없음 | 이 표의 권한이 없다(0008·0023 GRANT 목록) | 영향 없음. 권한이 생기면 그때 정책도 더한다 |
| 정의자 권한 함수 `public_open_times`·`search_document_source_at`·`search_sync_poster` | 0004·0023 | `promoter`를 읽지 않는다 | 영향 없음 |
| 다른 서비스 | — | core 논리 DB를 직접 읽지 않는다 | 영향 없음 |

- 서비스 시작 확인(`assertDatabaseRole`)은 바꾸지 않는다. 앱 역할은 표 소유자가 아니다(0004·ADR-0241 결정 1). 시험 ⑦이 `promoter`의 소유자를 본다.

### 4. 손댈 파일과 담당

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 구현 | `services/core-svc/migrations/0040_promoter_row_security.sql`(새 파일) | 위 2의 1~4. 머리 주석에 까닭(0034가 행 보안 없이 열었다)과 정본(ADR-0327 결정 13, ADR-0241, authz-matrix §5.3)을 적는다. 문장마다 `--> statement-breakpoint` |
| 구현 | `services/core-svc/migrations/meta/_journal.json` | `{"idx":40,"version":"7","when":<구현 직전 develop 마지막 when보다 큰 값>,"tag":"0040_promoter_row_security","breakpoints":true}`. 스냅숏은 만들지 않는다(0033·0034와 같다) |
| 구현 | `services/core-svc/src/modules/catalog/adapters/db/drizzle-commission-rate.ts` 3행 주석 | '`promoter` 표는 파트너에게 열지 않는다'가 0034 뒤로 틀렸다. '자기 행의 판매자 정보 칸만 연다(0040, ADR-0327 결정 13). 수수료율 칸은 열지 않는다'로 바꾼다(주석만) |
| 시험 | `services/core-svc/test-int/rls.int.test.ts` | 99행·118행 시험 고침, 판매자 표 ①~⑦ 더함, `core_ops` 로그인 사용자 더함(아래 5), 머리 주석에 0040 |
| 시험 | `services/core-svc/test-int/search-read-model.int.test.ts` 549~566행 | R165-1의 0023 앞 표 준비를 그때 있던 칸만 적은 SQL로 바꾼다(아래 5 끝). 단언·다른 시험은 그대로 둔다 |
| 계획(이 커밋) | ADR-0327(상태 보충·관련·관련 ID·결정 13·결과), ADR-0241(상태 보충), authz-matrix §3.3·§5.3, data.md `promoter.id` 설명, settlement ASVS 8.4.1 구현 칸 | 정본 빈칸 먼저(ADR-0256 결정 10) |

- 구현 커밋은 시험 파일을 건드리지 않는다. 시험 커밋은 시험 파일과 이 계획 파일만 바꾼다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: `0034_sale_review_request.sql`(이미 적용된 마이그레이션), `schema.ts`(그림자 객체를 더하지 않는다, 위 1.3), `database-role.ts`(감독에게 3의 (다)), 계약(`docs/api/`)·생성물·화면.
- 운영 확인 표(§8.4)는 해당 없음이다. 새 기능·관측·운영 절차가 없고, 권한만 좁힌다.

### 5. 시험 목록(시험 담당. 단언 값은 정본에서)

AZ-T5의 판정 기준(authz-matrix §7)은 ①②로 나뉘지 않는다. 그래서 정본 세부 번호는 없고, 이름에 `AZ-T5`와 계획 안 번호 `판매자 표 ①~⑦`을 단다. 번호를 ID 바로 뒤에 붙이지 않아 장부(`ledger.mjs`)가 정본 세부로 읽지 않는다. 시드는 지금 파일의 판매자 A·B(`'(주)에이'`·`'(주)비'`)를 쓴다. `partner`는 연결 하나짜리 풀(34행 주석)이라 연결 재사용 경우가 저절로 생긴다. 새 `ops = await loginFor(admin, pg, 'core_ops_login', 'core_ops', 1)`을 `beforeAll`에 더하고 `afterAll`에서 닫는다.

| 시험 이름 | 단언(정확한 값) | 단언 값 출처 | 구현 전 트리 |
| --- | --- | --- | --- |
| `AZ-T5 판매자 표 ① 테넌트 조건을 뺀 조회도 자기 판매자 행만 준다 [ASVS v5.0.0-8.4.1]` | 테넌트 A 트랜잭션의 `select id from promoter`(조건 없음)가 정확히 `[A]`, 테넌트 B는 `[B]` | AZ-T5 '첫째는 A의 행만', authz-matrix §3.3 판정 식, ADR-0327 결정 13 | 실패(`[A,B]`) |
| `AZ-T5 판매자 표 ② 테넌트 없이는 읽기·고치기 모두 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]` | 테넌트 A 트랜잭션을 한 번 돈 뒤, 테넌트 없는 트랜잭션의 읽기가 `[]`이고 조건 없는 `UPDATE promoter SET legal_name`이 **오류 없이** A·B를 바꾸지 않는다(`admin`으로 두 상호 그대로). 트랜잭션 밖 `partner.db` 읽기도 `[]` | AZ-T5 '둘째는 0건', authz-matrix §5.3(NULL·빈 문자열) | 실패(`[A,B]`, 2행 바뀜) |
| `AZ-T5 판매자 표 ③ 조건 없는 고치기로도 다른 파트너의 판매자 행을 바꾸지 못하고 넣기·지우기 권한이 없다 [ASVS v5.0.0-8.4.1]` | 테넌트 A로 **WHERE도 RETURNING도 없는** `tx.update(promoter).set({ legalName: … })` 뒤 `admin`으로 B의 상호가 `'(주)비'` 그대로, A만 바뀜. 같은 테넌트의 `tx.delete(promoter)`와 B 행 넣기가 `42501`. 끝에 A 상호를 `admin`으로 되돌린다 | AZ-T3(쓰기 0건), ADR-0327 결정 13(넣기·지우기 정책 없음), 위 2 'PostgreSQL 동작' | 실패(B 바뀜) |
| `AZ-T5 판매자 표 ④ 자기 판매자 행의 판매자 정보 여덟 칸은 고치고 읽는다(운영자 확인 시각은 그대로) [ASVS v5.0.0-8.4.1]` | 테넌트 A로 8칸을 서로 다른 값으로 `UPDATE … WHERE id = A RETURNING id`가 `[{ id: A }]`. 같은 테넌트로 9칸(`id`+8칸) 읽기가 그 값 1행. `admin`으로 A의 8칸이 새 값, `verified_at` NULL, B 행 그대로. 끝에 A를 되돌린다 | ADR-0327 결정 1(판매자 6칸+신고번호·면제 근거)·결정 11(`verified_at`은 쓰지 않음)·결정 13, data.md `promoter` | 통과(이미 있는 동작). 실패는 M7·M8·M9로 본다 |
| `AZ-T5 판매자 표 ⑤ 자기 행이라도 판매자 정보 밖의 칸은 읽지도 고치지도 못한다(운영자 확인 시각·수수료율·계약 변경 대기) [ASVS v5.0.0-8.2.3]` | 테넌트 A로 `promoter.verifiedAt`·`promoterContractState.commissionRateBp`·`promoterContractState.pendingContractApprovalId`를 칸마다 따로 읽으면 각각 `42501`. `verifiedAt`·`commissionRateBp` 고치기도 각각 `42501`(칸마다 따로 단언, 목록 밖의 값마다 거부) | ADR-0327 결정 11·13, ADR-0320 결정 8 | 실패(세 칸 읽기가 된다). 고치기 둘은 이미 `42501` |
| `AZ-T5 판매자 표 ⑥ 팬 경로 사용자는 모든 판매자 행을 읽기만 하고 관제 사용자는 모든 판매자 행을 본다 [ASVS v5.0.0-8.4.1]` | `app.db.select().from(promoter)`(기본 객체 모든 칸, 회차 상세가 읽는 모양)의 id가 정렬해 `[A,B]`. `app.db.update(promoter)`는 `42501`. `ops.db.select({ id }).from(promoter)`가 정렬해 `[A,B]` | AZ-T5 '팬·관제 사용자와 일괄 작업 사용자는 정책대로 본다', ADR-0241 결정 3, ADR-0200, ADR-0320 결정 8 | 통과(행 보안이 없다). 실패는 M12·M13으로 본다 |
| `AZ-T5 판매자 표 ⑦ 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책 넷이 정한 모양이다 [ASVS v5.0.0-8.4.1]` | `pg_class`의 `promoter`가 `relrowsecurity = true`·`relforcerowsecurity = false`, 소유자가 `core_partner`·`core_app`·`core_ops`와 그 로그인 사용자가 아님. `pg_policies`(public, `promoter`, `roles::text[]`로 읽음)가 이름 차례로 정확히 넷: `(promoter_app_read, SELECT, {core_app}, USING 있음, CHECK 없음)`, `(promoter_ops, ALL, {core_ops}, 있음, 있음)`, `(promoter_partner_self_read, SELECT, {core_partner}, 있음, 없음)`, `(promoter_partner_self_update, UPDATE, {core_partner}, 있음, 있음)`. 파트너 두 정책의 `qual`과 고치기 정책의 `with_check`는 `production_partner_tenant`의 `qual` 글에서 `promoter_id`를 `id`로 바꾼 것과 같다 | ADR-0327 결정 13, ADR-0241 결정 1·3과 '다른 선택지'(FORCE 없음), AZ-T5 '앱 사용자가 표 소유자가 아니고' | 실패(행 보안 꺼짐, 정책 0개) |
| 99행 → `[ASVS v5.0.0-8.4.1] 리뷰 재현: 코드가 쓰지 않는 표는 읽지 못한다(승인 전 공연 별칭·출연진)` | 101행(판매자) 줄을 지우고 `search_alias`·`production_artist` 둘은 그대로 `42501` | ADR-0241 결정 4(넣기만), ADR-0327 결정 13(판매자는 ①~⑤가 본다) | 통과 |
| 118행 → `[ASVS v5.0.0-8.4.1] 다른 공연을 지울 권한이 없다` | 120행(판매자) 줄을 지우고 ③으로 옮긴다. `tx.delete(production)` `42501`은 그대로 | ADR-0241 결정 4 | 통과 |
| R165-1(이름 그대로) | 단언은 그대로다. 549~566행의 `d.db.insert(…)` 일곱 곳을 `d.pool.query`의 SQL로 바꾼다: `promoter (id, legal_name)`, `place (id, name, address, region, created_by)`, `production (id, promoter_id, place_id, title, genre, sale_review, sale_approved_at)`, `event (id, production_id, promoter_id, venue_id, open_at, starts_at, ends_at)`, `artist (id, name, created_by)`, `production_artist (production_id, artist_id, sort_order)`, `search_alias (id, target_kind, target_id, alias, source, created_by)`. 값은 지금 줄 그대로. '0022 모양의 DB라 지금 Drizzle 객체(정의된 칸을 모두 적는다)를 쓰지 않는다'는 주석 한 줄 | BAT-165 R165-1(계획 `docs/review/plans/BAT-165.md`), `promoter-contract.int.test.ts` 71~91행 꼴 | 고친 뒤 통과(시험 쪽 결함). 고치기 전 실패는 CI 44919441525, 단언이 무는지는 M16 |

- 시험 쓰기 주의:
  - ③은 반드시 WHERE·RETURNING 없이 고친다(위 2. 아니면 M6이 살아남는다).
  - 상태를 바꾼 시험(③④)은 끝에 `admin`으로 되돌린다. 같은 파일의 뒤 시험(①의 `[A]` 등)이 시드 값에 기대지 않게, 단언은 id만 쓰거나 되돌린 뒤의 값을 쓴다.
  - 42501은 지금 파일처럼 `rejects.toMatchObject({ cause: { code: '42501' } })`로 본다.
  - 세 상태(테넌트 있음·없음·빈 문자열)는 ①②가 덮는다.
- 회귀(새로 쓰지 않음, 게이트에서 돈다): `sale-review-db.int.test.ts`(실제 `core_partner`·`core_ops`로 요청·현황·목록·상세), `promoter-contract.int.test.ts`(실제 `core_ops`로 파트너사 등록·계약 변경), `production-image.int.test.ts` 654행·`sale-policy.int.test.ts` 277행(실제 `core_app`으로 회차 상세), `test/migrations-journal.test.ts`(0040 `when` 차례).

### 6. 실패 확인(시험 담당이 할 일)

- **어디서**: 시험 커밋을 이 계획 커밋 위에 쌓은 트리(구현 전, 0040 없음)에서 돈다. 통합 시험이라 Docker가 있어야 한다.
- **차례**: `docker info` → `bash D:/ticketpass-locks/lock.sh take docker lane2-W12-core-rls`(남이 쥐었으면 `who`를 적고 기다리지 말고 감독에게 알린다) → `pnpm exec turbo run build --filter=@peaket/core-svc^...` → `pnpm --filter @peaket/core-svc test:integration test-int/rls.int.test.ts test-int/search-read-model.int.test.ts` → 자기 컨테이너만 `docker rm -f -v` → `lock.sh drop docker lane2-W12-core-rls`.
- **기대**: 판매자 표 ①②③⑤⑦은 **단언 실패**다(실행조차 안 되는 실패가 아니다. 5 표 '구현 전 트리' 칸의 값으로 실패한다). ④⑥, 고친 99·118행, 고친 R165-1은 통과한다. ④⑥의 실패는 검증의 M7·M8·M9·M12·M13으로, R165-1은 M16으로 본다(§8.6 7 '구현 전 트리에서 실패를 볼 수 없는 시험'). R165-1이 구현 전 트리에서도 실패하면 표 준비 고침이 덜 된 것이니 시험 담당이 더 고친다.
- **'실패 확인' 절에 적을 것**: 돌린 명령, 파일마다 통과·실패 수, 실패한 시험마다 실제 값(예: `[A,B]`), 처음부터 통과한 시험과 그 실패를 볼 틀린 구현 번호, Docker 잠금을 잡고 놓은 시각.

### 7. 틀린 구현 표본(검증 담당, 16개, 항목마다 1개 이상)

기준선은 구현 뒤 트리에서 `rls.int.test.ts`·`search-read-model.int.test.ts`·`sale-review-db.int.test.ts`·`promoter-contract.int.test.ts`·`production-image.int.test.ts` 전부 통과다. 표본마다 하나만 넣고 돌린 뒤 `git checkout -- <파일>`로 되돌린다. 0040을 바꾸는 표본은 통합 시험이 파일마다 새 컨테이너에 마이그레이션을 다시 올리므로 그대로 걸린다.

| # | 항목 | 넣을 곳 | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- | --- |
| M1 | ① | 0040 | `ENABLE ROW LEVEL SECURITY` 줄을 뺀다(정책은 있으나 걸리지 않는다) | ①②③⑦ |
| M2 | ① | 0040 | 파트너 읽기 정책 USING을 `nullif(current_setting('app.tenant_id', true), '') is not null`로(테넌트가 걸렸는지만 본다) | ①⑦ |
| M3 | ①(소유자 우회) | 0040 끝 | `ALTER TABLE "promoter" OWNER TO core_partner`(앱 역할이 소유자가 되어 행 보안을 건너뛴다) | ①②③⑦ |
| M4 | ② | 0040 | 파트너 두 정책에서 `nullif`를 빼고 `current_setting('app.tenant_id', true)::uuid`로 | ②(연결 재사용에서 22P02) |
| M5 | ② | 0040 | 파트너 읽기 정책 USING을 `id = coalesce(nullif(…)::uuid, id)`로(테넌트가 없으면 모두) | ②⑦ |
| M6 | ③ | 0040 | 파트너 고치기 정책 USING을 `true`로(WITH CHECK만 테넌트 식) | ③⑦ |
| M7 | ④ | 0040 | 파트너 고치기 정책을 뺀다(읽기 정책만) | ④⑦, `sale-review-db` S-T41 ①⑤(판매자 정보가 저장되지 않음) |
| M8 | ④ | 0040 | 파트너 읽기 정책을 뺀다(고치기 정책만) | ④①⑦(WHERE가 칸을 읽어 0행), `sale-review-db`(파트너 현황 404) |
| M9 | ④(비교 대상 틀림) | 0040 | 파트너 두 정책의 설정 이름을 `app.tenant`로 틀린다 | ①④⑦, `sale-review-db` |
| M10 | ⑤ | 0040 | `REVOKE SELECT ON "promoter" FROM core_partner`를 뺀다(표 단위 읽기가 남는다) | ⑤ |
| M11 | ⑤ | 0040 | `GRANT UPDATE ("verified_at") ON "promoter" TO core_partner`를 더한다 | ⑤ |
| M12 | ⑥ | 0040 | `promoter_app_read`를 뺀다 | ⑥⑦, `production-image` 654행·`sale-policy` 277행(회차 상세 404) |
| M13 | ⑥ | 0040 | `promoter_ops`를 뺀다 | ⑥⑦, `promoter-contract`(등록 42501·목록 0건), `sale-review-db`(관제 목록·상세) |
| M14 | ⑦ | 0040 | 파트너 고치기 정책의 WITH CHECK를 뺀다 | ⑦만(행동은 같다, 위 2. 동등에 가까운 변이라 구조 단언이 잡는다) |
| M15 | ⑦ | 0040 | `ALTER TABLE "promoter" FORCE ROW LEVEL SECURITY`를 더한다 | ⑦만(시험의 `admin`은 슈퍼유저라 FORCE도 건너뛴다) |
| M16 | R165-1 | `src/modules/catalog/application/search-maintenance.ts` 140행 `start()` | `await this.#reconcile(at);`를 뺀다(시작 따라잡기를 하지 않는다) | R165-1(검색이 `[]`) |

- 세지 않는 것: 정책 식을 `promoter_id = …`로 옮겨 적는 실수는 그 칸이 없어 0040 자체가 42703으로 실패한다. 모든 통합 시험이 멈추니 잡히지만 표본으로 세지 않는다. 장애 주입은 해당 없음이다(복구 경로가 없는 권한 변경이다).
- '검증' 절에 적을 것: 표본마다 실패한 시험 이름, 놓친 표본과 시험 담당에게 넘긴 것, AZ-T5 판정 기준 세 문장과 ①②⑥⑦ 단언의 대조.

### 8. 게이트 명령과 닿는 CI 잡

```bash
cd /d/ticketpass-lane2-b171
pnpm exec turbo run build --filter=@peaket/core-svc^...
pnpm --filter @peaket/core-svc typecheck
pnpm --filter @peaket/core-svc test                     # 단위 전부(migrations-journal의 0040 when 포함)
# Docker 잠금(lock.sh take docker lane2-W12-core-rls)을 잡고, 합치기 직전 develop 위로 다시 쌓은 트리에서
PEAKET_TEST_REPORT=test-report-int.json pnpm --filter @peaket/core-svc test:integration   # 통합 전부(ADR-0283 결정 3)
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "AZ-T5, v5.0.0-8.4.1, v5.0.0-8.2.3" --report services/core-svc/test-report-int.json
node tools/ci/roles-check.mjs --base origin/develop --head feature/lane2-W12-core-rls   # 감독이 합치기 직전
```

| 잡 | 왜 |
| --- | --- |
| `ci-node.yml` / node | core-svc typecheck·단위·통합 시험(이번 실패가 난 잡) |
| `docs-check` / docs | ADR·authz-matrix·data.md·ASVS·이 계획 |
| `lint-guard` | 서비스 층 규칙(주석만 바꿈) |

- 장부: BUILD_ORDER 묶음이 아니라 `ledger.mjs --batch`는 쓰지 않는다. 기록 담당이 `node tools/ci/ledger.mjs`로 다시 쓰고 `docs/review/ledger/security.md` AZ-T5 줄이 '자동 시험' 그대로인지 본다.
- `pnpm`이 응용 프로그램 제어에 막히면 `npx tsc -p services/core-svc/tsconfig.json --noEmit`과 `npx vitest run --config vitest.integration.config.mjs <파일>`(core-svc 폴더)로 대신한다.
- 리뷰는 보안 관점이다. 정책 식, 칸 권한, 다른 역할 경로(위 3 표), 소유자·FORCE, N-1 호환, 시험이 1차 조건(쿼리의 테넌트 조건) 없이 2차(행 보안)만 보는지를 본다.

### 9. 자주 놓친 결함 가운데 해당하는 것

| 결함(docs/architecture.md §8.6) | 이 묶음에서 |
| --- | --- |
| 저장소 응답은 정확한 값까지 | ①은 id 목록 전체, ③은 B 행의 상호 값, ④는 8칸 값과 `verified_at` NULL |
| 세 상태의 가운데 | 테넌트 있음(①)·없음(②)·빈 문자열(② 연결 재사용) |
| 겹친 가드는 하나씩 빼 본다 | 칸 권한(GRANT)과 행 보안이 겹친다. ⑤는 칸 권한만(M10·M11), ③은 행 보안만(M6) 뺐을 때 실패한다. 쿼리의 테넌트 조건(1차)은 시험에 넣지 않는다 |
| 허용·거부 목록은 목록 밖 값마다 | ⑤에서 판매자 정보 밖 세 칸을 칸마다 읽기·고치기 |
| 부르는 쪽이 결과를 쓰는지 | 실제 역할로 HTTP를 지나는 `sale-review-db`·`promoter-contract`·회차 상세 시험을 회귀로 함께 돈다 |
| 시험 값을 상수와 다르게 | 8칸 새 값은 시드·코드 상수와 다른 글자로 |

### 10. 범위 밖

- `idempotency_record` 행 보안(감독에게 2, 아래 11).
- 감독에게 3의 정리 후보 (가)~(마).
- 0034 파일 고치기(이미 적용된 마이그레이션은 고치지 않는다). 계약·생성물·화면 변경.
- 판매자 정보 변경 요청 표 `seller_profile_change`(data.md에만 있고 코드·마이그레이션이 없다).

### 11. OPEN 문안 후보(감독 결정 대기, 같은 문제의 다른 표)

> **OPEN[다음 번호]** core-svc `idempotency_record` 역할별 행 보안(보안 높음 후보, W12-core-rls 계획이 찾음). 지금 `core_partner`(0004)·`core_app`(0027)이 읽기·넣기·고치기, `core_ops`(0033)가 지우기까지, 모든 작업의 기록을 행 보안 없이 다룬다. 파트너 경로의 쿼리 하나가 잘못되면 팬 굿즈 결제 시도의 재생 응답(`START_MERCH_PAYMENT`의 `result_ref`, 결제창 값 JSON: 금액·돌아올 주소)을 읽거나 바꿀 수 있다. ADR-0241 결정 4의 전제('값은 만든 ID뿐이다')가 0027 뒤로는 맞지 않는다.
> (가) 추천: 역할마다 자기 작업의 기록만 다루는 정책을 둔다. `core_partner`는 `CREATE_PRODUCTION`·`CREATE_PRODUCTION_EVENT`, `core_app`은 굿즈·부가 상품 일곱(`CREATE_MERCH_ORDER`·`START_MERCH_PAYMENT`·`ACCEPT_MERCH_PAYMENT`·`CREATE_TICKET_ADDON`·`CANCEL_MERCH_ORDER`·`RETURN_MERCH_ORDER`·`SHOP_CANCEL_REFUND_ACCOUNT`), `core_ops`는 `CREATE_OPS_PROMOTER`·`CREATE_OPS_PROMOTER_CONTRACT_CHANGE`만. 새 묶음(돈 길이라 A)으로 하고 ADR-0241 결정 4와 ADR-0146을 보충한다.
> (나) 표를 역할마다 나눈다(옮기는 비용이 크다).
> (다) 그대로 두고 정리 목록에 적는다.

## 실패 확인

시험 담당(세션 `lane2-w12corerls-test`)이 2026-11-22에 위 6대로 돌렸다. 길은 **(가) 로컬 Docker**다. 트리는 계획 커밋 `db33521bc` 위에 시험 파일 둘만 고친 작업 트리(구현 전, 0040 없음)다.

- **Docker 잠금**: 01:46에 `lane2-W12-dt50`이 쥐고 있었다(01:42:21부터). 15초 간격으로 `take`를 다시 해 **02:03:21에 잡았고 02:05:09에 놓았다**(`lock.sh drop docker lane2-W12-core-rls`). 컨테이너 이름 앞머리를 `PEAKET_TEST_CONTAINER_PREFIX=w12corerls-`로 붙였고, 끝난 뒤 `docker ps -a --filter name=w12corerls-`가 0개였다(시험이 스스로 `rm -f -v`). 다른 갈래 컨테이너·kind는 건드리지 않았다. 감독 차례(갈래 1 BAT-059 → 갈래 4 BAT-355 → 갈래 2)에 따라 이 뒤로는 잠금을 다시 잡지 않는다.
- **정적 검사**(잠금 전): `pnpm --filter @peaket/core-svc typecheck` 통과(`tsconfig.json`이 `test-int`를 포함하는지 일부러 틀린 파일로 확인하고 지웠다), `pnpm lint` 통과.
- **명령**: `pnpm exec turbo run build --filter=@peaket/core-svc^...`(4/4 캐시) → `pnpm --filter @peaket/core-svc test:integration test-int/rls.int.test.ts test-int/search-read-model.int.test.ts`(02:03:51 시작, 60.7초, 끝 코드 1).
- **결과**: 파일 2개 중 1개 실패. 시험 58개 중 **5개 실패·53개 통과·건너뜀 0**. `rls.int.test.ts` 24개 중 5개 실패, `search-read-model.int.test.ts` 34개 전부 통과.

| 시험 | 결과 | 실제 값(구현 전 트리) | 까닭 |
| --- | --- | --- | --- |
| AZ-T5 판매자 표 ① | **실패(단언)** | 테넌트 A의 조건 없는 조회가 `[A, B]`, 테넌트 B도 `[A, B]` | 행 보안이 없어 표 단위 읽기(0034)가 모든 행을 준다 |
| AZ-T5 판매자 표 ② | **실패(단언)** | 그 연결의 `app.tenant_id`가 `''`(연결 재사용 확인됨)인데 테넌트 없는 읽기가 `[A, B]`, 트랜잭션 밖 읽기도 `[A, B]`, 조건 없는 고치기가 A·B 상호를 모두 `(주)테넌트없이고침`으로 바꿈 | 같음. 고치기는 오류 없이 2행을 바꿨다 |
| AZ-T5 판매자 표 ③ | **실패(단언)** | WHERE·RETURNING 없는 테넌트 A의 고치기 뒤 B의 상호가 `(주)비`가 아니라 `(주)에이 조건없이고침`. 지우기·넣기는 이미 `42501`(그 두 줄은 단언 전에 돌아 통과) | 행 보안이 없어 칸 고치기 권한(0034)이 모든 행에 걸린다 |
| AZ-T5 판매자 표 ④ | 통과 | — | 이미 있는 동작(자기 행 8칸 고치기·읽기). 실패는 검증의 M7·M8·M9로 본다 |
| AZ-T5 판매자 표 ⑤ | **실패(단언)** | 읽기 셋(`verified_at`·`commission_rate_bp`·`pending_contract_approval_id`)이 `됨`. 고치기 넷(`verified_at`·`commission_rate_bp`·`pending_contract_approval_id`·`id`)은 이미 `42501` | 표 단위 SELECT(0034)가 남아 있다. 칸마다 결과를 한 객체로 모아 단언해 일곱 칸이 다 보인다 |
| AZ-T5 판매자 표 ⑥ | 통과 | — | 행 보안이 없어 팬·관제 사용자가 다 본다. 실패는 M12·M13으로 본다 |
| AZ-T5 판매자 표 ⑦ | **실패(단언)** | `promoter`의 `relrowsecurity = false`, `relforcerowsecurity = false`, `pg_policies` 0개. 기대한 파트너 식은 `(id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`(0004 `production_partner_tenant`의 글에서 바꾼 것, 그 앞 가드 `promoter_id = ` 포함은 통과) | 0040이 없다 |
| 리뷰 재현: 코드가 쓰지 않는 표는 읽지 못한다(승인 전 공연 별칭·출연진) | 통과 | — | 판매자 줄을 지웠고 별칭·출연진은 그대로 `42501` |
| 다른 공연을 지울 권한이 없다 | 통과 | — | 판매자 고치기 줄을 지웠다(③으로 옮김) |
| R165-1 | 통과 | — | 0023 앞 표 준비를 그때 있던 칸만 적은 SQL(`d.pool.query`)로 바꿔 42703이 사라졌다. 단언이 무는지는 M16으로 본다 |

- **시험 쓰기에서 계획과 다르게 한 것**(단언을 약하게 한 것은 없다):
  - ③의 넣기는 B의 `id`가 아니라 새 `id`로 했다. 같은 테넌트(A)로 남의 판매자 행을 새로 넣는 경우이고, B의 `id`면 권한이 잘못 열렸을 때 `23505`(키 중복)로 갈려 원인이 흐려진다.
  - ④는 `admin`으로 A의 `verified_at`을 먼저 값(`2026-10-01T03:00:00Z`)으로 채운 뒤 그대로인지 본다(NULL이 우연히 NULL로 남는 것보다 강하다). 읽기는 `WHERE id = A`로 한다(조건 없는 읽기는 ①이 본다).
  - ⑤는 계획의 다섯에 `pending_contract_approval_id` 고치기와 `id` 고치기를 더해 일곱이다(목록 밖 값마다).
  - ⑥의 팬 경로 읽기는 id만이 아니라 두 행의 모든 칸 값을 단언한다.
  - ⑦은 `promoter_ops`·`promoter_app_read`의 `qual`을 '있음'이 아니라 정확히 `true`로 본다(결정 13 '조건 없는 정책', '읽기만 전체').
  - 상태를 바꾸는 시험의 되돌리기는 시험 끝 줄이 아니라 판매자 표 묶음의 `afterEach`가 한다(시험이 실패해도 되돌린다. 구현 전 트리에서 ②가 두 행을 바꿨다).

## 시험 결과

(시험 담당이 구현 뒤 트리의 결과를 쓴다.)

- **초안 PR CI(구현 담당이 적음)**: PR #56(초안, 머리 `4c22d930c`), GitHub Actions 실행 **44930078460**의 `node / node` 잡. PR 실행이라 develop과 합친 트리다.
  - core-svc 통합 시험: 파일 48개 중 47개 통과·1개 건너뜀, 시험 484개 중 **483개 통과·1개 건너뜀·실패 0**. 건너뛴 것은 `local-partner-stack.int.test.ts`(`PEAKET_LOCAL_STACK=1`일 때만 돈다, 늘 건너뜀).
  - `rls.int.test.ts` 24개 전부 통과(AZ-T5 판매자 표 ①~⑦ 포함), `search-read-model.int.test.ts` 34개 전부 통과(R165-1 포함). 회귀로 본 `sale-review-db`(4)·`promoter-contract`(14)·`production-image`(32)·`sale-policy`(8)도 통과.
  - core-svc 단위 104파일·771개, typecheck, lint, platform·identity·payment·queue·trust·admission-ctrl 통합은 통과.
  - 잡이 실패한 까닭은 이 묶음과 무관한 purchase-svc 통합 2개다: `purchase-migration.int.test.ts` 'GAT080_0014(예매 취소): order_cancellation은 …CHECK를 만든다'(CHECK 목록 8개, 기대 6개), `event-refund.int.test.ts` 'GAT-110 P3 실제 DB에서 그 밖 실패의 끝내기를 실패시키면 …'(outbox 넣기 쿼리 실패). 이 묶음은 purchase-svc를 바꾸지 않는다. `ci-summary`는 그 때문에 실패다. ASVS 태그 리포트 단계(`continue-on-error`)의 `test-report-search-golden.json` 형식 경고도 이 묶음과 무관하다.

## 구현

구현 담당(세션 `lane2-w12corerls-impl`)이 2026-11-22에 위 2·4대로 했다. 시험 파일은 건드리지 않았다.

- **바꾼 것**:
  - `services/core-svc/migrations/0040_promoter_row_security.sql`(새 파일): 차례대로 `REVOKE SELECT ON "promoter" FROM core_partner` → `GRANT SELECT ("id"와 판매자 정보 8칸) ON "promoter" TO core_partner` → `ENABLE ROW LEVEL SECURITY`(FORCE 없음) → 정책 넷(`promoter_partner_self_read` FOR SELECT, `promoter_partner_self_update` FOR UPDATE USING·WITH CHECK, `promoter_ops` FOR ALL `USING (true) WITH CHECK (true)`, `promoter_app_read` FOR SELECT `USING (true)`). 파트너 두 식은 `"id" = nullif(current_setting('app.tenant_id', true), '')::uuid`다. 정책마다 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`(0033 꼴), 문장마다 `--> statement-breakpoint`. 0034의 칸 고치기 8칸은 넓히지 않았다. 머리 주석에 까닭과 정본(ADR-0327 결정 13, ADR-0241 결정 1·3, authz-matrix §3.3·§5.3)을 적었다.
  - `services/core-svc/migrations/meta/_journal.json`: `{"idx":40,"version":"7","when":1795281728010,"tag":"0040_promoter_row_security","breakpoints":true}`. `git fetch origin` 뒤 `origin/develop`(`456df0929`)의 마지막은 그대로 `0034_sale_review_request`(1795118255889)이고 0035~0039는 develop에 없다. 스냅숏은 만들지 않았다(0033·0034와 같다).
  - `services/core-svc/src/modules/catalog/adapters/db/drizzle-commission-rate.ts` 3~4행 주석만: '자기 행의 판매자 정보 칸만 연다(0040, ADR-0327 결정 13). 수수료율 칸은 열지 않는다'.
  - 바꾸지 않은 것: 쿼리, `schema.ts`, `database-role.ts`(`assertDatabaseRole`), 0034, 계약·생성물. R165-1 때문에 고친 것은 없다(위 1.3).
- **게이트(로컬, Docker 없이)**: `pnpm exec turbo run build --filter=@peaket/core-svc^...` 4/4 캐시, `pnpm --filter @peaket/core-svc typecheck` 통과, `pnpm --filter @peaket/core-svc test` 104파일·771개 통과(`migrations-journal` 포함), `pnpm lint` 통과, `python -I -X utf8 tools/doc-check/check_all.py` 오류 0·경고 4(모두 이 묶음과 무관한 openapi·mermaid 경고) → 통과. 마이그레이션 전용 검사 도구는 `tools/ci`에 없다. 통합 시험은 로컬 Docker를 쓰지 않고(감독 차례) 초안 PR CI로 본다(위 '시험 결과').

## 리뷰

- 담당 `lane2-w12corerls-review`(claude-opus-5-5). 관점은 보안이다(감독 결정). 범위는 `db33521bc..dd1dad429`(시험 `4441aecff`, 구현 `4c22d930c`·`df47c187e`·`dd1dad429`)다. 바뀐 부분과 정본(ADR-0327 결정 13, ADR-0241, authz-matrix §3.3·§5.3, data.md `promoter`)으로 판단했다. 코드·시험은 고치지 않았고 Docker도 쓰지 않았다. 통합 시험 결과는 위 '시험 결과'의 초안 PR CI를 근거로 쓴다.
- **막는 지적(높음·보안·통과 기준)은 없다.** 대조한 것:
  1. **정책 식과 테넌트 값**: 파트너 두 정책의 식은 결정 13, 그리고 0004 `production_partner_tenant`와 같다(`0040_promoter_row_security.sql` 22~23·28~30행). 값을 걸지 않으면 `current_setting(…, true)`가 NULL이다. 앞 트랜잭션이 쓴 연결이면 `''`이고 `nullif`가 NULL로 바꾼다. 그래서 둘 다 0건이다. 테넌트 값은 플랫폼 트랜잭션 도우미만 건다. `set_config(…, true)`라서 그 트랜잭션에만 걸리고, 빈 값이 오면 던진다(`packages/platform/src/database.ts` 186·191~193행). 세션 단위로 거는 곳은 저장소에 없다. 값의 모양이 틀리면 `uuid` 변환 오류(22P02)가 난다. 하지만 그 오류는 행 내용이 아니라 건 값에만 달려 있고, 바깥 응답은 500 일반 문구뿐이다(`problem-filter.ts`). 그래서 새는 정보가 없다. 정책 식의 `id`는 정책을 만들 때 이 표의 칸에 묶인다. 그래서 `UPDATE … FROM`으로 결합한 다른 표의 `id`로 바뀌지 않는다.
  2. **고치기와 칸 권한**: 0040은 UPDATE 권한을 더하지 않는다. 0034가 준 8칸 그대로다. 파트너는 `id` 칸을 고칠 권한이 없다. 그래서 행 바꿔치기는 권한에서 먼저 막히고(⑤ `updateId` 42501), WITH CHECK가 두 번째로 막는다(⑦이 식을 본다). 읽기는 `id`와 8칸이다(0040 14행). 표의 열두 칸 가운데 나머지는 ⑤가 칸마다 본다. 읽기는 셋(`verified_at`·`commission_rate_bp`·`pending_contract_approval_id`), 고치기는 그 셋과 `id`를 더한 넷이다. 파트너 코드가 읽는 칸은 이 아홉 칸 안이다(`drizzle-sale-store.ts` 259~264행의 현황, 579~591행 요청의 WHERE).
  3. **REVOKE→GRANT 차례**: 표 단위 REVOKE는 같은 종류(SELECT)의 칸 권한까지 거둔다. 그래서 이 차례여야 칸 읽기가 남는다(12·14행). 다른 마이그레이션은 `core_partner`에게 표 단위 SELECT도, 스키마 전체 SELECT도, 기본 권한 SELECT도 주지 않는다. 0004의 `ON ALL TABLES`와 기본 권한은 `core_app`에만 준다. develop과 다른 가지에는 아직 0035 이상의 core 마이그레이션이 없다.
  4. **다른 역할**: `core_ops`의 정책은 FOR ALL 참이다. 이것은 ADR-0320 결정 8의 '조건 없는 정책'이고, 권한은 0033 그대로다(읽기·넣기와 계약 두 칸 고치기, 지우기 없음). `core_app` 읽기 참은 결정 13이 정한 행 범위다. 상호·대표자·주소·연락처·사업자번호는 회차 상세가 싣는 판매자 신원정보(ADR-0200, POL-037)다. 그래서 정본이 허용하는 칸이다. 칸 범위의 남은 문제는 RV-01에 적었다. `core_maintenance`·`core_search`는 이 표의 권한이 없다(0008·0022·0023). 권한만 더하는 실수가 생겨도 0건이다. 행 보안은 정책이 없으면 거부하고, ⑦이 '정책은 정확히 넷'을 단언하기 때문이다. FORCE가 없을 때 행 보안을 건너뛰는 것은 표 소유자, 그리고 소유자 권한으로 도는 보기(view)와 정의자 권한 함수다. 지금 `promoter`를 읽는 보기·정의자 함수는 없다(RV-03). 두 역할을 겸하면 정책이 OR로 합쳐지는데, 서비스 시작 검사가 다섯 역할을 모두 본다(`database-role.ts` 18~29행). Drizzle 마이그레이터는 남은 마이그레이션을 한 트랜잭션으로 돈다. 그래서 행 보안만 켜지고 정책이 아직 없는 순간이 다른 연결에 보이지 않는다.
  5. **시험**: ①~③은 쿼리의 테넌트 조건(1차) 없이 행 보안(2차)만 본다. ②는 연결 하나짜리 풀에서 앞 트랜잭션의 연결을 다시 쓰고, 그 연결의 값이 `''`인 것까지 단언한다. ③은 WHERE도 RETURNING도 없는 고치기라 고치기 정책만 행을 거른다. ④는 `verified_at`을 미리 채워 두고 그대로인지 본다. ⑦은 정책 넷의 이름·명령·역할·식을 정확히 견준다. 파트너 식은 0004 정책 글에서 만들어 견주므로 `missing_ok` 인자나 `nullif`가 빠진 변형도 잡는다. 처음 쓰는 연결의 NULL 경우는 ②가 만들지 못하는데, 그 몫을 ⑦이 묶는다. 단언 값은 계획 5 표의 출처(AZ-T5 판정 기준, 결정 1·11·13)와 맞다. 고친 옛 시험 둘은 판매자 줄만 지웠고, 그 범위는 ①~⑤가 더 강하게 본다. 다른 단언은 약해지지 않았다. R165-1은 표 준비를 칸을 적은 SQL로만 바꿨고 값과 단언은 그대로다.
  6. **역할 경계·꼬리말**: 시험 커밋 `4441aecff`는 시험 파일 둘과 이 파일만 바꿨다. 구현 커밋 셋은 0040·저널·주석 한 곳과 이 파일만 바꿨고 시험 파일은 없다. 저널의 0040 `when` 1795281728010은 0034의 1795118255889보다 크다. 다섯 커밋 모두 꼬리말 덩이를 갖췄고, 세션 ID가 담당 표와 같다. `node tools/ci/roles-check.mjs --base 650ef80e0 --head HEAD`의 실패는 'review·verify 커밋이 없다' 하나뿐이다(이 커밋과 검증이 채운다).
- 지적은 중간 1·낮음 3이다. 이 묶음에서 고치지 않고 정리 목록으로 넘긴다(ADR-0283 결정 6, ADR-0331 결정 5).

| 번호 | 등급 | 자리 | 근거 | 고칠 방향 |
| --- | --- | --- | --- | --- |
| RV-01 | 중간 | `0040_promoter_row_security.sql` 40행, `0004_partner_row_security.sql` 21·25행 | `core_app`은 0004의 표 단위 읽기로 `promoter`의 열두 칸을 모두 읽는다. 0040의 `promoter_app_read`(참)로 모든 행도 읽는다. 그래서 팬 경로 DB 사용자가 계약 값의 사본(`commission_rate_bp`)과 계약 변경 대기 ID를 읽는다. 아직 판매 승인 전인 판매자의 연락처·사업자번호도 읽는다. 0040이 넓힌 것은 아니고(0004부터 그랬다), 결정 13은 행 범위만 정했다. 그런데 ADR-0320 결정 8은 팬 경로에서 계약 표를 거뒀고(0033 92행), 결정 13은 같은 세 칸을 파트너에게서 막았다. 팬 경로 코드는 `id`·8칸·`verified_at`만 읽는다(`drizzle-catalog-repository.ts` 106행의 `promoter` 기본 객체). 같은 수수료율 값이 `event.commission_rate_bp`에도 있다. 또 기본 권한(0004 25행) 때문에 앞으로 이 표에 더할 칸도 `core_app`에게 저절로 열린다 | 고칠 쪽: 정본 → 구현. 계획 '감독에게' 3 (가)와 한 줄로 합친다. ADR-0320 결정 8(또는 ADR-0327 결정 13)에 두 가지를 정한다. 하나는 `core_app`이 읽는 `promoter` 칸(`id`·8칸·`verified_at`)이고, 하나는 `event.commission_rate_bp`의 처리다. 새 마이그레이션은 0040과 같은 차례로 `REVOKE SELECT ON "promoter" FROM core_app` 뒤에 칸 GRANT를 한다. 판매 승인된 공연이 있는 판매자 행만 보이게 할지(ADR-0200 결정 4)도 함께 정한다 |
| RV-02 | 낮음 | `rls.int.test.ts` 425행(⑦ 끝 줄), `database-role.ts` 24행 | ⑦의 소유자 검사는 소유자가 이름 여섯(`core_partner`·`core_app`·`core_ops`와 그 로그인 사용자) 가운데 하나인지만 본다. 그래서 두 실수를 못 잡는다. 하나는 결정 13이 '권한 없음'으로 정한 `core_maintenance`·`core_search`(AZ-T5의 '일괄 작업 사용자')가 소유자가 되는 것이다. 다른 하나는 앱 로그인 사용자가 구성원인 역할이 소유자가 되는 것이다. 표 소유자는 정책을 건너뛴다. 운영의 시작 검사도 `production`·`event`의 소유자만 본다(계획 '감독에게' 3 (다)) | 고칠 쪽: 시험·구현. ⑦은 다섯 역할마다 `pg_has_role(역할, c.relowner, 'member')`가 거짓인지 본다(시작 검사와 같은 꼴). 시작 검사는 표 목록에 `promoter`를 더하거나, 행 보안을 켠 표 전체로 넓힌다((다)와 한 줄) |
| RV-03 | 낮음 | `0040_promoter_row_security.sql` 7행(FORCE 없음) | FORCE가 없으면 표 소유자만 행 보안을 건너뛰는 것이 아니다. 소유자가 만든 보기(기본은 소유자 권한으로 돈다)와 정의자 권한 함수도 건너뛴다. 지금은 그런 보기·함수가 없다. 정의자 함수 셋(`public_open_times`·`search_document_source_at`·`search_sync_poster`)은 `promoter`를 읽지 않고, `search_document_source` 보기는 함수만 부른다. 그러나 이것을 지키는 시험도 정본 문장도 없다. 뒤에 판매자 칸을 싣는 보기 하나가 파트너 경로에 열리면, 남의 판매자 행이 조용히 보이게 된다 | 고칠 쪽: 정본(시험은 후보). authz-matrix §5.3의 core-svc 문단에 한 줄을 더한다: '행 보안을 켠 표를 읽는 보기는 `security_invoker`로 만들고, 정의자 함수는 함수 안에서 테넌트와 칸을 좁힌다'. 시험 후보는 `pg_depend`로 `promoter`에 기대는 보기·함수 목록이 정한 목록(지금은 빈 목록)과 같은지 보는 것이다 |
| RV-04 | 낮음 | `docs/security/asvs/settlement.md` 135행(8.4.1)·133행(8.2.3)의 검증 칸 | 계획 커밋이 8.4.1 행에 판매자 표 문장을 더했지만, 검증 칸은 '미실행' 그대로다. 그 문장은 이제 자동 시험(AZ-T5 판매자 표 ①~④·⑥·⑦)이 본다. 8.2.3 행(파트너 응답의 판매자 정보 칸)의 검증 칸도 DB 칸 권한을 보는 ⑤를 가리키지 않는다. 이 표를 읽는 사람은 시험이 없다고 읽게 된다 | 고칠 쪽: 정본(기록 담당). 8.4.1 검증 칸에 '판매자 표는 자동 시험 AZ-T5 판매자 표 ①~④·⑥·⑦, J-T10은 미실행'을 적는다. 8.2.3 검증 칸에는 ⑤를 더한다 |

- **판정: 통과.** 막는 지적이 없으므로 검증(위 7의 틀린 구현 16개)으로 넘긴다. 검증 담당이 알아 둘 것이 하나 있다. RV-02 때문에 '소유자를 `core_search`나 `core_maintenance`로 바꾸는' 변형은 지금 시험이 잡지 못한다. 표본 밖이고, 알고 넘긴다.

## 검증

- 담당 `lane2-w12corerls-verify`(claude-opus-5-5). 계획·시험·구현·리뷰에 관여하지 않았다. 트리는 리뷰 커밋 `6c92deaaf`(구현 뒤)다. 제품·시험 코드는 커밋하지 않았다. 표본은 하나씩 넣고 돌린 뒤 `git checkout -- <파일>`로 되돌렸고, 매번 `git status --short`가 비어 있는 것을 봤다.
- **Docker 잠금**: 갈래 4가 놓았다는 감독 알림 뒤 `lock.sh who docker`가 '비어 있음'이었고 **03:11:46에 잡았고**(owner.txt 둘째 줄에 예상 끝 04:01:46) **03:43:32에 놓았다**(자세한 것은 아래 '전체 회귀' 끝). 컨테이너 이름 앞머리는 `PEAKET_TEST_CONTAINER_PREFIX=w12corerls-`다. 다른 갈래의 컨테이너·kind는 건드리지 않았다.
- **기준선**: `pnpm exec turbo run build --filter=@peaket/core-svc^...`(4/4 캐시) 뒤 계획 7의 기준선 파일 여섯(`rls`·`search-read-model`·`sale-review-db`·`promoter-contract`·`production-image`·`sale-policy`)이 시험 116개 모두 통과(62초).

### 틀린 구현 검사(16개 중 16개 잡힘, 놓침 0)

표본마다 계획 7의 '잡아야 할 시험'이 든 파일만 돌렸다(M1~M6·M10·M11·M14·M15는 `rls.int.test.ts`, M7~M9는 거기에 `sale-review-db`, M12는 `production-image`·`sale-policy`, M13은 `promoter-contract`·`sale-review-db`, M16은 `search-read-model`). 표본을 넣는 도구는 바꿀 글이 정한 횟수만큼 정확히 나오지 않으면 멈추게 했다(작업 폴더 밖 임시 스크립트, 커밋하지 않음).

| # | 틀린 구현 | 계획이 기대한 시험 | 실제로 실패한 시험 | 판정 |
| --- | --- | --- | --- | --- |
| M1 | `ENABLE ROW LEVEL SECURITY` 뺌 | ①②③⑦ | ①②③⑦ (24개 중 4개) | 잡힘 |
| M2 | 파트너 읽기 USING을 '테넌트가 걸렸는지만' | ①⑦ | ①⑦ | 잡힘 |
| M3 | 끝에 `OWNER TO core_partner` | ①②③⑦ | ①②③⑤⑦, '리뷰 재현: 슈퍼유저가 아닌 소유자로도 마이그레이션되고…'(6개). ⑦은 소유자 목록 단언에서 실패했다 | 잡힘 |
| M4 | 파트너 두 정책에서 `nullif` 뺌(세 곳) | ②(22P02) | ②(연결 재사용에서 `22P02 invalid input syntax for type uuid: ""`), ⑦ | 잡힘 |
| M5 | 읽기 USING을 `id = coalesce(…, id)` | ②⑦ | ②⑦ | 잡힘 |
| M6 | 고치기 USING을 `true`(WITH CHECK는 테넌트 식) | ③⑦ | ②③⑦. B 행이 바뀌어서가 아니라, 고친 B 행이 WITH CHECK에 걸려 고치기 전체가 `42501 new row violates row-level security policy`로 실패했다(두 번째 가드가 막음, B 상호는 그대로) | 잡힘 |
| M7 | 파트너 고치기 정책 뺌 | ④⑦, `sale-review-db` S-T41 ①⑤ | ③④⑦, S-T41 ①⑤(고치기가 0행이라 A도 안 바뀜) | 잡힘 |
| M8 | 파트너 읽기 정책 뺌 | ①④⑦, `sale-review-db` | ①④⑦, S-T41 ①⑤·④ | 잡힘 |
| M9 | 파트너 두 정책의 설정 이름을 `app.tenant`로(세 곳) | ①④⑦, `sale-review-db` | ①③④⑦, S-T41 ①⑤·④ | 잡힘 |
| M10 | `REVOKE SELECT … FROM core_partner` 뺌 | ⑤ | ⑤(읽기 셋 `verified_at`·`commission_rate_bp`·`pending_contract_approval_id`가 '됨') | 잡힘 |
| M11 | `GRANT UPDATE ("verified_at") … TO core_partner` 더함 | ⑤ | ⑤(`updateVerifiedAt`이 '됨') | 잡힘 |
| M12 | `promoter_app_read` 뺌 | ⑥⑦, 회차 상세 둘 | ⑥⑦, `production-image` 'GET /v1/events/{eventId}의 posterUrl·posterAlt·detailImages…', `sale-policy` '공개 요약 salePhases·refundFees·PRESALE 배지는…'(64개 중 4개) | 잡힘 |
| M13 | `promoter_ops` 뺌 | ⑥⑦, `promoter-contract`, `sale-review-db` | ⑥⑦, `promoter-contract` J-T29 ②·⑨ 둘·J-T30 ⑤(넷), `sale-review-db` S-T41 ①⑤·④·⑤(셋)(42개 중 9개) | 잡힘 |
| M14 | 파트너 고치기 정책의 WITH CHECK 뺌 | ⑦만 | ⑦만 | 잡힘 |
| M15 | `FORCE ROW LEVEL SECURITY` 더함 | ⑦만 | ⑦만 | 잡힘 |
| M16 | `start()`의 `await this.#reconcile(at);` 뺌 | R165-1 | R165-1 '표 마이그레이션 전부터 승인돼 있던 공연은…', 그 밖에 R165-1 '모든 파드가 내려가 있던 동안…'·R165-14·R165-23(34개 중 4개) | 잡힘 |

- **놓친 것: 없다.** 그래서 이 표본에서 시험 담당에게 넘길 시험은 없다.
- **알고 넘긴 것(RV-02, 표본 밖)**: 리뷰가 짚은 '소유자를 `core_search`·`core_maintenance`로 바꾸는' 변형을 한 번 넣어 봤다(X1: 0040 끝에 `OWNER TO core_search`). **⑦은 통과했다(놓침).** 실패한 것은 '리뷰 재현: 슈퍼유저가 아닌 소유자로도 마이그레이션되고…' 하나뿐인데, 까닭이 소유자 규칙이 아니라 슈퍼유저가 아닌 마이그레이션 사용자가 `core_search`로 바꿀 권한이 없다는 것이었다(`42501 must be able to SET ROLE "core_search"`). 운영처럼 그 권한이 있는 사용자가 마이그레이션하면 판매자 표 시험 모두를 지난다. 표 소유자는 행 보안을 건너뛰므로 검색 연결이 모든 판매자의 연락처를 읽게 되는 권한 결함이다. 다만 고칠 방향(⑦을 다섯 역할의 `pg_has_role(…, 'member')`로 바꾸고 시작 검사를 넓힘)은 리뷰 RV-02와 계획 '감독에게' 3 (다)에 이미 있다. 그래서 새로 넘기지 않고 그 정리 줄에 이 실행 결과를 근거로 붙이기를 권한다(기록 담당).
- 덧붙여 본 것: M6에서 보듯 고치기 정책의 USING이 틀려도 WITH CHECK가 남의 행 바꾸기를 오류로 막는다. M14(WITH CHECK 뺌)는 행동이 같아 ⑦의 구조 단언만 잡는다. 두 가드가 서로를 받친다는 계획 2의 설명과 맞다.

### 판정 기준 대조

정본은 AZ-T5 판정 기준([authz-matrix](../../security/authz-matrix.md) §7: '첫째는 A의 행만, 둘째는 0건이다. 팬·관제 사용자와 일괄 작업 사용자는 정책대로 본다. 앱 사용자가 표 소유자가 아니고 `BYPASSRLS`가 없다'), ADR-0327 결정 13, ADR-0271 결정 12(R165-1)다.

| 시험 | 정본 기준 | 시험 단언 | 대조 |
| --- | --- | --- | --- |
| 판매자 표 ① | AZ-T5 '첫째는 A의 행만', authz-matrix §3.3(`id = 요청 테넌트`) | 테넌트 조건 없는 조회가 A는 정확히 `[{id: A}]`, B는 `[{id: B}]` | 충족 |
| 판매자 표 ② | AZ-T5 '둘째는 0건', §5.3(`nullif`로 빈 문자열도 NULL) | 같은 연결의 값이 `''`인 것까지 보고, 읽기 `[]`·트랜잭션 밖 읽기 `[]`·조건 없는 고치기가 오류 없이 A·B 상호 그대로 | 충족. 한 번도 값을 걸지 않은 연결(NULL) 경우는 직접 만들지 않고 ⑦이 식 글(`true` 인자·`nullif`)을 묶는다 |
| 판매자 표 ③ | 결정 13 '넣기·지우기 정책은 두지 않는다(권한도 없다)', AZ-T3 | WHERE·RETURNING 없는 고치기 뒤 B 상호 `(주)비` 그대로·A만 바뀜, 지우기·넣기 `42501` | 충족 |
| 판매자 표 ④ | 결정 1·11(판매자 정보 8칸, `verified_at`은 쓰지 않음)·13 | 8칸 새 값 고치기 `[{id: A}]`, 9칸 읽기 그 값, 저장값 8칸 새 값·미리 채운 `verified_at` 그대로·B 행 그대로 | 충족 |
| 판매자 표 ⑤ | 결정 13 '칸 단위로 좁힌다', ADR-0320 결정 8 | 판매자 정보 밖 세 칸 읽기와 그 셋+`id` 고치기, 일곱이 칸마다 `42501` | 충족(표의 열두 칸 가운데 나머지 아홉은 ④가 본다) |
| 판매자 표 ⑥ | AZ-T5 '팬·관제 사용자는 정책대로', 결정 13(`core_ops` 조건 없음, `core_app` 읽기만 전체), ADR-0200 | 팬 경로가 두 행의 모든 칸 값, 팬 경로 고치기 `42501`, 관제가 `[A, B]` | 팬·관제는 충족. **일괄 작업 사용자(`core_maintenance`·`core_search`, 결정 13 '권한이 없어 정책을 두지 않는다')는 미시험**이다. ⑦의 '정책은 정확히 넷'이 그 역할의 정책이 없음은 묶지만, 그 역할에 권한이 없다는 것은 보지 않는다. 권한만 생기면 0건이라 지금 새는 길은 없다 |
| 판매자 표 ⑦ | AZ-T5 '앱 사용자가 표 소유자가 아니고', 결정 13(행 보안 켬·FORCE 없음·정책 넷의 이름·명령·역할·식) | `relrowsecurity` 참·`relforcerowsecurity` 거짓, 정책 넷을 정확히, 파트너 식은 0004 정책 글에서 만든 것과 같음, 소유자가 앱 역할 여섯 이름이 아님 | 부분. 정책·FORCE는 충족. 소유자는 이름 여섯만 보아 `core_search`·`core_maintenance`·구성원 역할이 소유자인 경우를 놓친다(위 X1, RV-02). `BYPASSRLS`는 기존 '앱 사용자는 표 소유자가 아니고 BYPASSRLS가 없으며…' 시험이 `core_partner`·`core_app`과 그 로그인 사용자만 본다 |
| R165-1 '표 마이그레이션 전부터 승인돼 있던 공연은…' | ADR-0271 결정 12('서버가 뜰 때 주기 일을 걸기 전에 `reconcileAll`을 한 번', '이미 있는 DB의 첫 채우기') | 0022까지 올린 DB에 그때 칸만 적은 SQL로 승인 둘·초안 하나를 넣고, 띄우기 전 검색 `[]`(대조군), `start()` 뒤 검색·자동완성이 승인 둘, 초안 줄 0, 이름 줄 키가 `nameKeys`와 같음, 어긋난 줄 0 | 충족(M16이 잡음). 이 묶음은 표 준비만 바꿨고 값·단언은 그대로다 |

- 요약: 충족 6(①②③④⑤ 판매자 표, R165-1), 부분 2(⑥의 일괄 작업 사용자 미시험, ⑦의 소유자 범위). 부분 둘은 지금 새는 길이 아니고(권한이 없거나 소유자가 바뀌지 않았다) 리뷰 RV-02·'감독에게' 3 (다)의 정리 줄과 같은 자리다.

### 전체 회귀

`pnpm --filter @peaket/core-svc test:integration`(파일 48개, 시험 484개)을 잠금 안에서 돌렸다. 한 번에 깨끗하게 끝나지 않았다. 실패는 모두 시간 초과·연결 끊김·429(서버 바쁨)였다. 제 시험이 멈춘 동안에도 PC의 CPU 사용률이 22~100%로 오르내렸다(다른 프로그램). Docker 엔진에는 다른 컨테이너가 없었다.

| 실행 | 시각 | 결과 | 실패한 곳 |
| --- | --- | --- | --- |
| 1 기본 작업자 수 | 03:21~03:25, 217초 | 파일 2개 실패, 시험 475 통과·8 실패·1 건너뜀 | `shop-expiry` 6개(`RedisDeadlineError` Redis 호출 마감 100ms 넘김), `search-read-model` 2개(R165-2·SR-T7, 30초 시간 초과) |
| 1의 두 파일만 다시 | 03:25~03:26 | 46/46 통과 | — |
| 2 작업자 6 | 03:26~03:33, 382초 | 시험 474 통과·7 실패·3 건너뜀 | `shop-expiry` 5개(같은 마감 초과), `search-read-model` 1개 실패·2개 건너뜀(연결 시간 초과·429), `search-bat166` SR-T13 ① 시간 비교(81.5ms, 기준 75ms 미만) |
| 3 기본 작업자 수 | 03:34~03:39, 314초 | 파일 18개 실패, 시험 261 통과·29 실패·194 건너뜀 | 모두 시간 초과(시험 30초·준비 120초·seatmap-worker 시작 기다림)·연결 끊김·429 |
| 4 실행 3에서 실패한 18개 파일만 | 03:41~03:43, 116초 | **18개 파일 311/311 통과** | — |

- **합친 결과**: 실행 3에서 모두 통과한 29개 파일과 실행 4의 18개 파일을 시험 보고서 JSON(작업 폴더 밖)으로 합치면 **파일 48개, 483개 통과·1개 건너뜀(`local-partner-stack`, 늘 건너뜀)·실패 0**이다. **PR #56 CI(483개 통과·1개 건너뜀·실패 0)와 같다.**
- 판매자 표와 닿는 파일(`rls` 24·`sale-review-db` 4·`promoter-contract` 14·`sale-policy` 8)은 실행 1~3 모두 통과했다. `production-image` 32는 실행 1·2에서 통과했고, 실행 3에서는 준비 단계 시간 초과로 통째로 건너뛰었다가 실행 4에서 통과했다. `search-read-model`이 실패한 자리(155·269·416·632·1353행)는 이 묶음이 표 준비를 바꾼 R165-1(526행)이 아니고, R165-1은 매번 통과했다.
- 이 흔들림은 이미 정리 목록에 있다. Redis 마감 100ms 초과는 `docs/lanes/lane1-cleanup.md` PRF-168('전체 실행에서 매번 다른 시험 2~5개, 따로 돌리면 통과')이고, `search-bat166`의 시간 비교는 `docs/lanes/lane2-cleanup.md` BAT-174 R-699 줄이다. 이 묶음의 변경(0040·주석 한 줄·시험 두 파일)은 굿즈·검색 시간 경로에 닿지 않는다. 그래서 새로 넘기지 않는다.
- **Docker 잠금**: 03:11:46에 잡고 **03:43:32에 놓았다**(`lock.sh drop docker lane2-W12-core-rls`, 뒤의 `who`는 '비어 있음'). 놓기 전 `docker ps -a --filter name=w12corerls-`가 0개였다(시험이 스스로 `rm -f -v`).

### 게이트

| 명령 | 결과 |
| --- | --- |
| `pnpm exec turbo run build --filter=@peaket/core-svc^...` | 4/4 캐시 |
| `pnpm --filter @peaket/core-svc typecheck` | 통과 |
| `pnpm --filter @peaket/core-svc test` | 104파일·771개 통과(`migrations-journal`의 0040 `when` 차례 포함) |
| `pnpm lint` | 통과 |
| `python -I -X utf8 tools/doc-check/check_all.py` | 아래 '판정'의 첫 줄 |
| `node tools/ci/trace-check.mjs --ids "AZ-T5" --report <실행 3 보고서> --report <실행 4 보고서>` | `AZ-T5 통과 24`. 계획 8의 `--ids "AZ-T5, v5.0.0-8.4.1, v5.0.0-8.2.3"`도 통과(8.4.1 38·8.2.3 5) |
| `node tools/ci/roles-check.mjs --base 650ef80e0 --head HEAD` | 아래 '판정'의 첫 줄 |

### 남은 위험

- RV-02(위 X1): 소유자 검사가 이름 여섯만 본다. 소유자가 바뀌는 마이그레이션은 이 시험만으로는 막지 못한다.
- RV-01: `core_app`이 판매자 표 열두 칸을 모두 읽는다(0004부터). 이 묶음은 행 범위만 정했다.
- RV-03: FORCE가 없어 소유자 권한 보기·정의자 함수가 행 보안을 건너뛴다. 지금 그런 보기·함수는 없다.
- `idempotency_record` 행 보안 없음('감독에게' 2, OPEN 문안 후보 11).
- 위 넷은 모두 리뷰·계획이 정리 목록·OPEN 후보로 넘긴 것이고, 이 묶음을 막지 않는다.

### 판정

- 문서 점검과 역할 확인: `check_all.py`는 이 절을 쓴 뒤 오류 0이다(경고는 이 묶음과 무관한 openapi·mermaid 경고뿐). `roles-check`는 이 커밋 전에 실패가 '코드 묶음에 verify 커밋이 없다' 하나뿐이었다(plan 1·test 1·impl 3·review 1). 이 커밋이 그것을 채운다.
- **판정: 합쳐도 됨.** 틀린 구현 16개를 모두 잡았고, 놓친 표본이 없어 시험 담당에게 넘길 시험이 없다. 판정 기준은 충족 6·부분 2이고, 부분 둘(일괄 작업 사용자의 권한 없음, 소유자 검사 범위)은 지금 새는 길이 아니며 리뷰 RV-02·계획 '감독에게' 3 (다)와 같은 정리 줄이다. core-svc 통합 전체는 다시 돌린 파일까지 합쳐 483/483(건너뜀 1)으로 PR #56 CI와 같다.
- 기록 담당에게: RV-02 정리 줄에 위 X1 실행 결과(⑦ 통과, 소유자를 `core_search`로 바꿔도 판매자 표 시험이 모두 지남)를 근거로 붙인다. 로컬 전체 실행의 흔들림은 PRF-168·BAT-174 R-699 줄의 새 사례로 한 줄 덧붙일지 본다.

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane2-w12corerls-plan | claude-opus-5-5 | 2026-11-22T01:05+09:00 | 2026-11-22T01:40+09:00 |
| test | lane2-w12corerls-test | claude-opus-5-5 | 2026-11-22T01:38+09:00 | 2026-11-22T02:12+09:00 |
| impl | lane2-w12corerls-impl | claude-opus-5-5 | 2026-11-22T02:11+09:00 | 2026-11-22T02:48+09:00 |
| review | lane2-w12corerls-review | claude-opus-5-5 | 2026-11-22T02:50+09:00 | 2026-11-22T03:08+09:00 |
| verify | lane2-w12corerls-verify | claude-opus-5-5 | 2026-11-22T03:09+09:00 | 2026-11-22T03:50+09:00 |

## 기록

(기록 담당이 쓴다.)

- **다음 단계: 기록 → 합치기.** 구현(`4c22d930c`), 초안 PR #56 CI(실행 44930078460, core-svc 통합 483개 통과·실패 0), 리뷰(보안, 막는 지적 없음), 검증(틀린 구현 16개 중 16개 잡힘, 판정 '합쳐도 됨')이 끝났다.
