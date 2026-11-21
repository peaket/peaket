# 작업 계획: W12-core-idem(core-svc 멱등 기록 표의 역할별 행 보안·굿즈 재생 대조)

- **무엇**: core-svc 멱등 기록 표 `idempotency_record`(같은 요청을 다시 보냈을 때 처음 결과를 돌려주려고 키와 결과를 적어 두는 표)에 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)이 없어 파트너(`core_partner`)·팬(`core_app`)·관제(`core_ops`) 세 DB 역할이 모든 작업의 기록을 읽고 고친다. 감독 결정(2026-11-22): 보안 높음, 등급 A(시험 먼저, 틀린 구현은 항목마다, 리뷰는 보안 관점). 방향은 '역할마다 자기 작업의 기록만 다룬다. 행 보안으로 묶고, 재생할 때 지금 요청과 같은 주체·같은 작업인지 앱 층에서도 본다'. 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2`, 가지 `feature/lane2-W12-core-idem`, 출발점 `origin/develop` `456df0929`. 2026-11-22 계획 담당(세션 `lane2-w12coreidem-plan`)이 썼고 제품·시험 코드는 쓰지 않았다. 마이그레이션 **0041**·ADR **0337**은 감독이 나눈 번호다(`docs/lanes/coord.md` '번호 나누기(웨이브 12)').
- **앞 묶음**: W12-core-rls(작업 폴더 `D:/ticketpass-lane2-b171`, 가지 `feature/lane2-W12-core-rls`. 그 계획 파일은 아직 그 가지에만 있어 `git show`로 읽었다)가 0040으로 `promoter`에 행 보안을 넣는다. 이 묶음은 그 묶음이 develop에 합쳐진 뒤 rebase해 시험·구현한다. 정책 꼴(역할·명령마다 나눈 정책, `app.tenant_id`와 `nullif`, 칸 단위 GRANT, FORCE 없음)은 그 계획과 같다.
- **차례**: 시험 먼저. 계획 → 시험(구현 전 트리에서 실패 확인) → 구현 → 리뷰(보안) → 리뷰 반영 → 검증(틀린 구현 23개) → 기록. 계획 커밋에 `Batch-Order`를 달지 않는다(docs/architecture.md §8.6 '차례').
- **정본**: [ADR-0337](../../adr/0337-core-idempotency-record-role-row-security.md)(새로 씀), [ADR-0241](../../adr/0241-core-svc-partner-row-security.md) 결정 1·3·4(보충)·6·7, [ADR-0146](../../adr/0146-data-retention-gaps-idempotency-records-log-retention.md) 결정 1(상태 보충), [guidelines](../../api/guidelines.md) §4('예외 셋째'를 더함), [authz-matrix](../../security/authz-matrix.md) §2·§5.3(새 줄)·§7 **AZ-T17**(새 시험 ID), [data.md](../../data.md) '서비스마다 둔 멱등 기록 표', [asvs/payment](../../security/asvs/payment.md) 8.2.2, [asvs/catalog-review](../../security/asvs/catalog-review.md) 8.4.1, ADR-0299 결정 3, ADR-0300 결정 5·8, ADR-0315 결정 3, ADR-0316 결정 5.

## 감독에게

1. **로컬 재현은 못 했다.** 02:03:41 `lock.sh take docker lane2-W12-core-idem`이 1로 끝났다(`lane2-W12-core-rls`가 02:03:21부터 쥠). 기다리지 않고 코드·마이그레이션 읽기로 위험을 세웠다(아래 2). 잠금·컨테이너는 건드리지 않았다. 시험 담당의 실패 확인(7)이 첫 로컬 실행이다.
2. **W12-core-rls와 겹치는 파일**(그쪽이 먼저 합쳐지고 이 가지가 rebase한다):
   - `services/core-svc/migrations/meta/_journal.json`: 그쪽 idx 40, 이쪽 idx 41. 0041의 `when`은 0040과 구현 직전 develop 마지막 `when`보다 커야 한다(`test/migrations-journal.test.ts`). 0035~0039(갈래 3·5 몫)가 뒤에 합쳐지면 그쪽이 다시 매긴다.
   - `test-int/rls.int.test.ts`: **고치지 않는다.** 새 시험은 새 파일 셋(5)에 둔다.
   - 정본: ADR-0241(그쪽 상태 보충 줄, 이쪽 결정 4 끝), authz-matrix(그쪽 §3.3 테넌트 표 줄·§5.3 core-svc 줄, 이쪽 §5.3 ops-svc 줄 **아래** 새 줄·§7 새 줄), data.md(그쪽 `promoter`, 이쪽 멱등 기록 표 문단). 붙지 않은 줄이라 rebase 충돌은 없을 것이다. 나면 두 쪽 글을 다 남긴다.
3. **정비 연결 권한(확인 필요, 고치지 않음).** 정비 일 `idempotency-records-delete`(platform `platformMaintenanceTasks`)는 relay의 `PEAKET_MAINTENANCE_DATABASE_URL`로 돈다. `maintenance-tasks.ts` 2~3행은 그 사용자가 `core_maintenance`라 적지만 그 역할에는 이 표의 권한이 없다(0008·0022·0026). 같은 연결이 Outbox 파티션도 만드므로 운영은 표 소유자(또는 구성원)로 붙는다고 보고, 그러면 FORCE가 없어 0041 뒤에도 지운다. `core_maintenance`만이면 0041 전에도 42501이다. BAS-060(운영 실행기) 때 보기를 권한다.
4. **새 ADR-0337**: 작업과 역할의 짝, 테넌트 칸, 정책 열 개, 칸 권한, 재생 대조, 404·로그 모양(결정 1~6). ADR-0241 결정 4의 '값은 만든 ID뿐이다'는 0027 뒤로 틀려 보충을 붙였다. 0338은 쓰지 않는다.
5. **새 시험 ID AZ-T17**(authz-matrix §7, ①~⑧). AZ-T5는 테넌트 표 판정이라 역할·작업 축을 못 담는다. 계획 커밋 직전 develop과 원격 가지에 AZ-T17이 없음을 봤다.
6. **OPEN 문안 후보 둘**(13): 같은 역할 안의 계정 묶기, 굿즈 결제창 값을 저장하지 않는 재생.
7. **다른 표 목록**(14): 여덟 줄, 고치지 않음. 높음 후보는 `webhook_endpoint`(팬 경로 역할의 표 단위 고치기)와 `merch_order_item`(파트너의 표 단위 고치기, 정산 원천).
8. **WBS 일 [가정] 1.8일**(12).

## 계획

### 1. 조사 결과

#### 1.1 표와 권한(0034까지)

- 표: `0002_production_registration.sql` 3~12행, 칸 정의는 platform `idempotencyRecordTable`(`packages/platform/src/idempotency.ts`). 기본 키 (계정, 작업, 키), 작업 CHECK(0033이 11개로 다시 걸었다). 행 보안 없음.
- 권한: `core_partner` `SELECT, INSERT, UPDATE`(0004 36행), `core_app` `SELECT`(0004 21·25행)·`SELECT, INSERT, UPDATE`(0027 94행), `core_ops` `SELECT, INSERT, UPDATE, DELETE`(0033 84행). 모두 표 단위. `core_maintenance`·`core_search`는 없음.

#### 1.2 읽고 쓰는 코드 경로(전부, `grep -rn "idempotency_record\|IdempotencyStore\|@Idempotent(" services/core-svc/src`)

| 역할(연결) | 코드 | 작업 |
| --- | --- | --- |
| `core_partner`(`PEAKET_PARTNER_DATABASE_URL`) | `catalog/adapters/db/drizzle-catalog-repository.ts` 191~204행 `registerOnce`: `partnerDb.transaction(…, { tenantId })` 안의 `IdempotencyStore.run`. 첫 문장이 `set_config('app.tenant_id', …, true)`(`packages/platform/src/database.ts` 186~195행) | `CREATE_PRODUCTION`·`CREATE_PRODUCTION_EVENT`(`partner-production.controller.ts` 134·145행) |
| `core_app`(`PEAKET_DATABASE_URL`, `shop.module.ts` 170행) | `shop/adapters/db/drizzle-merch-orders.ts` 327~340행 `replayOf`(트랜잭션 밖 읽기), 343~356행 `#once`(`IdempotencyStore.run`) | `CREATE_MERCH_ORDER`·`START_MERCH_PAYMENT`·`ACCEPT_MERCH_PAYMENT`·`CANCEL_MERCH_ORDER`·`SHOP_CANCEL_REFUND_ACCOUNT`·`RETURN_MERCH_ORDER`(`shop-order.controller.ts`), `CREATE_TICKET_ADDON`(`ticket-addon.controller.ts`) |
| `core_ops`(`PEAKET_OPS_DATABASE_URL`, `catalog.module.ts` 233행) | `catalog/adapters/db/drizzle-promoter-store.ts` 167~196행 `create`, 198~245행 `reserveChange`, 257행 손으로 쓴 `delete from idempotency_record …`(`clearPending`). 계약 변경은 계정 대신 `ops-contract-change`(`domain/promoter-ports.ts` 80행) | `CREATE_OPS_PROMOTER`·`CREATE_OPS_PROMOTER_CONTRACT_CHANGE`(`ops-promoter.controller.ts` 80·108행) |
| 정비 연결 | `packages/platform/src/maintenance.ts` 185~188행 | 모두(감독에게 3) |
| 소유자·슈퍼유저 | 마이그레이션, 시험 `admin`(`shop-cancel.int.test.ts` 158행 등) | — |

- 작업 열하나가 세 역할에 겹치지 않고 나뉜다(ADR-0337 결정 1).
- `catalog.module.ts` 231행은 `opsDatabase`가 없으면 `OPS_DATABASE`를 `DATABASE`(core_app)로 떨어뜨린다. 운영 `main.ts` 63~64행은 주소가 없으면 시작하지 않는다. 관제 파트너사 경로를 실제 역할로 부르는 통합 시험은 `promoter-contract.int.test.ts`뿐이고 `opsDatabase`를 준다(102행).

#### 1.3 결과 참조(`result_ref`)에 든 것과 재생

| 작업 | 적는 값 | 재생(지금) |
| --- | --- | --- |
| 공연 등록·회차 더하기 | 응답 JSON `{ productionId, eventIds, warnings }`·`{ eventId, pending, warnings }`(`drizzle-catalog-repository.ts` 198행) | 그대로 `JSON.parse`(200행) |
| 굿즈 주문·부가 상품 주문 | 주문 ID(`drizzle-merch-orders.ts` 374행) | `findOrder`로 읽는다. **계정을 보지 않는다**(`create-merch-order.ts` 316~321행) |
| 결제 시도 시작 | **처음 응답 JSON 통째**: 시도 ID·결제사·허용 수단·결제창 값(토스 `clientKey`·`customerKey`·`orderId`·`orderName`·`amount`·`successUrl`·`failUrl`, 포트원 `storeId`·`channelKey`·`paymentId`·`totalAmount`·`redirectUrl`)·입금 기한(`merch-payment.ts` 90~100행, `merch-ports.ts` 115~127행) | 그대로 돌려준다(`merch-payment.ts` 55~56·101행) |
| 결제 접수 | `accepted`·`sold-out`(511·531행) | `sold-out`만 409, **다른 값은 모두 202**(`merch-payment.ts` 138~140행) |
| 취소·환급 계좌 다시 받기 | `cancel:{취소 ID}`(837·907행) | 그 취소 행을 읽는다. **주문·계정을 보지 않는다**(`merch-cancel.ts` 192행, `drizzle-merch-orders.ts` 843행) |
| 반품 | `return:{주문 ID}`(942행) | 세션 계정으로 그 주문을 읽는다. **경로 주문과 견주지 않는다**(`merch-return.ts` 31~34·53행) |
| 관제 파트너사 등록·계약 변경 | 파트너사 ID, 처음 202 JSON | `detail(ID)`, 그대로 |

- 티켓 결제 시도(purchase)는 결제창 값을 DB에 두지 않고 재생 때 다시 만든다(guidelines §4 '예외 둘째'). 굿즈는 기본 규칙대로 응답을 통째로 둬서 이 표에 결제창 값이 있다(13 OPEN-B).

#### 1.4 다른 서비스의 같은 꼴 표

- 행 보안을 건 멱등 기록 표는 저장소에 없다. DB 역할을 나눈 서비스는 core-svc·ops-svc뿐이다(`grep -l "CREATE ROLE" services/*/migrations/*.sql`).
- ops-svc 0015는 파트너 역할 `ops_partner`에 읽기·넣기만 주고 처음 응답을 넣기 문장에 싣는다(`drizzle-partner-store.ts` 5행, authz-matrix §5.3 'ops-svc 구현'). purchase·payment·ticket·identity는 앱 역할이 하나다.
- 그래서 이 저장소의 테넌트 표 행 보안 꼴(0004·0007·0033·W12-core-rls 0040)과 ops-svc의 '쓰는 만큼만 칸 권한'을 함께 쓴다.

### 2. 위험 재현(코드와 권한으로 세움, 로컬 실행은 감독에게 1)

| # | 잘못된 쿼리(경로) | 지금 결과 | 0041 뒤 |
| --- | --- | --- | --- |
| R1 | 파트너: `select account_ref, operation, result_ref from idempotency_record`(조건 빠짐) | 팬 계정 ID·결제창 값(구매자 키·금액), 다른 파트너 등록 결과, 관제 계약 변경 응답이 나온다 | 자기 테넌트의 파트너 기록만(①) |
| R2 | 파트너·관제: `update idempotency_record set result_ref = '<바꾼 결제창 JSON>' where operation = 'START_MERCH_PAYMENT'` | 그 팬의 같은 키 재요청이 바꾼 글을 그대로 받아 다른 상점 공개 키·다른 금액·다른 돌아올 주소로 결제창이 열린다 | 다른 역할 작업이라 0건(③). 팬 경로의 같은 결함은 시도·결제사·금액 대조가 404(⑥). 공개 키·주소 출처는 남는 한계(OPEN-B) |
| R3 | 아무 역할: `update … set created_at = now() - interval '25 hours'`(조건 빠짐), 관제: `delete … where idempotency_key = $1`(257행에서 계정·작업 조건이 빠진 꼴) | 팬 재요청이 새 요청으로 잡혀(`on conflict … where created_at <= 기한`) 굿즈 주문·결제 시도가 두 번 생긴다(취소는 부분 유일 인덱스가 막음, ADR-0315) | 자기 역할 작업 기록에만 닿는다. 지우기는 관제 작업만(③) |
| R4 | 아무 역할: `update … set account_ref = '<D>' where account_ref = '<C>'` | C의 기록이 D의 키 공간으로 옮겨진다 | 범위 칸 고치기 권한이 없다(④) |
| R5 | 파트너 A: 조건 빠진 `update … set result_ref = …` | B의 등록 재시도가 다른 공연 ID를 받는다 | A 기록만(①) |
| R6 | 팬: 재생 참조가 다른 팬 주문·다른 주문 취소를 가리키게 된 기록 | 그 주문·취소의 값이 지금 팬에게 나간다 | 404(⑥) |

### 3. 설계(정본: ADR-0337)

#### 3.1 0041이 하는 일

파일 `services/core-svc/migrations/0041_idempotency_record_role_security.sql`. `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`, `ADD COLUMN IF NOT EXISTS`로 다시 돌려도 같게(0033 꼴), 문장마다 `--> statement-breakpoint`, 머리 주석에 까닭과 정본.

1. `ADD COLUMN IF NOT EXISTS "tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid`. `current_setting`은 STABLE이라 표를 다시 쓰지 않고, 있던 행은 NULL이다.
2. 백필(결정 2): 공연 등록은 `production.id`, 회차 더하기는 `event.id`, 회차 행이 없으면 `production.pending_revision -> 'addedEvents'`에 그 `eventId`가 있는 공연의 `promoter_id`. SQL의 `AND`는 계산 차례를 보장하지 않으므로 `CASE WHEN pg_input_is_valid(result_ref, 'jsonb') THEN result_ref::jsonb END`로 거르고, ID는 `id::text = …->>'productionId'`처럼 글로 견준다(변환 오류로 배포가 멈추지 않게).
3. `REVOKE INSERT, UPDATE … FROM core_partner, core_app, core_ops` 뒤 `GRANT INSERT (account_ref, operation, idempotency_key, request_hash, result_ref, created_at)`·`GRANT UPDATE (request_hash, result_ref, created_at)`를 세 역할에. 차례를 바꾸지 않는다(표 단위 REVOKE는 같은 종류의 칸 권한도 거둔다). 읽기와 `core_ops` 지우기는 그대로.
4. `ENABLE ROW LEVEL SECURITY`. **FORCE 없음.**
5. 결정 3의 정책 열 개(작업 목록은 결정 1 그대로).

- `packages/platform`과 `schema.ts`의 표 객체는 바꾸지 않는다. 멱등 문장은 플랫폼의 SQL 글이라 `tenant_id`가 객체에 없어도 기본값이 든다. 시험은 이 칸을 SQL 글로 읽는다.

#### 3.2 PostgreSQL 동작에서 시험·검증이 알아야 할 것

- 플랫폼이 키를 잡는 `INSERT … ON CONFLICT DO UPDATE … RETURNING`은 INSERT WITH CHECK(새 행), UPDATE USING(부딪친 행)·WITH CHECK(고친 행), SELECT USING(`returning`·`where`가 칸을 읽음)을 모두 건다(PostgreSQL 18 CREATE POLICY 문서 명령별 표). 역할마다 읽기·넣기·고치기 정책이 다 있어야 첫 요청이 된다.
- ON CONFLICT DO UPDATE는 SET 칸의 UPDATE 권한만 있으면 된다(INSERT 문서 '권한'). 권한 검사는 충돌이 없어도 문장마다 하므로 `created_at` 고치기 권한이 빠지면 모든 첫 요청이 42501이다(M12).
- 칸을 읽지 않는 UPDATE(WHERE·RETURNING 없음)는 SELECT 정책이 걸리지 않는다. 고치기 USING을 보는 시험은 `update idempotency_record set result_ref = 'x'`처럼 쓴다(W12-core-rls 계획 2와 같다).
- 겹친 가드를 하나씩: 범위 칸 고치기는 칸 권한과 WITH CHECK가 겹친다. 칸 권한만 보려면 바꾸는 값을 그 역할 목록 안의 다른 작업·자기 테넌트 값으로 골라 WITH CHECK가 지나게 한다(예: 파트너 `set operation = 'CREATE_PRODUCTION_EVENT'`, `set tenant_id = <자기 테넌트>`, 넣기도 자기 테넌트 값).
- 소유자·슈퍼유저는 정책을 건너뛴다. 시험 `admin`은 슈퍼유저라, ⑥은 `admin`으로 기록을 바꿔 DB 가드 없이 앱 대조만 본다.
- 못 채운 0041 전 파트너 기록: ON CONFLICT의 WHERE(보관 기간)가 거짓이면 아무것도 하지 않고 이어 읽는 SELECT가 행을 못 봐 처리 중 409, 기간이 지나면 UPDATE USING에 걸려 42501이다(ADR-0337 '남는 한계').

#### 3.3 재생 대조(앱 층, 결정 6)

- 자리: `create-merch-order.ts` `#replayView`(세 곳에서 부름), `merch-payment.ts` 시작의 두 재생 길(55·101행)과 `#replay`(138행), `merch-cancel.ts`·`merch-refund-account.ts`의 `#replay`, `merch-return.ts` 두 재생 길(31~34·53행).
- 대조할 사실을 읽는 저장소 함수가 모자라면 `ShopOrderStore`에 읽기를 더한다(제안: 시도 ID로 그 시도의 주문·결제사 읽기, `cancelView`가 취소 행의 주문 ID도 주기). DB·메모리 저장소(`adapters/memory-*.ts`) 둘 다.
- 맞지 않으면 shop 로거 `error({ kind: 'idempotency-replay-mismatch', severity: 'SEV2', operation, orderId }, …)` 뒤 `orderNotFound()`. 계정 ID·결과 참조 원문은 싣지 않는다. 결제 시도 JSON을 못 읽어도 같은 길이다. 쓰기·결제사 호출보다 앞에서 끝낸다.

#### 3.4 이전 판 코드(N-1)와 함께 돌기

이전 판도 같은 플랫폼 문장(넣기 여섯 칸, SET 세 칸, 결과 `result_ref`)이라 새 칸 권한 안이고, 파트너 트랜잭션도 이미 테넌트를 걸어 기본값이 든다. 이전 판 재생은 대조하지 않지만 다른 역할의 변조는 DB가 막는다.

### 4. 다른 역할 영향(0041 뒤)

- `core_partner`: 등록·회차 더하기 그대로(테넌트가 기본값으로 들고 정책을 지난다). 다른 테넌트·역할 기록은 안 보인다.
- `core_app`: 굿즈 일곱 그대로. 파트너·관제 기록은 안 보인다. 맞지 않는 재생은 404.
- `core_ops`: 등록·계약 변경 요청·`clearPending` 지우기 그대로. 팬·파트너 기록은 안 보이고 안 지워진다.
- relay 리더 반복·shop 정비 일(core_app): 이 표를 안 쓴다(`#once`는 HTTP 유스케이스만). 정비 연결: 감독에게 3. `core_maintenance`·`core_search`, 마이그레이션·시험 `admin`, 다른 서비스: 영향 없음.
- 시작 확인(`assertDatabaseRole`)은 그대로(결정 7). 운영 확인 표(§8.4)는 해당 없음: 새 기능·지표·절차가 없고, 새 로그 한 줄은 보안 이벤트(authz-matrix §2의 7)다.

### 5. 손댈 파일과 담당

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 구현 | `services/core-svc/migrations/0041_idempotency_record_role_security.sql`(새) | 3.1 |
| 구현 | `migrations/meta/_journal.json` | `{"idx":41,"version":"7","when":<0040·develop 마지막보다 큼>,"tag":"0041_idempotency_record_role_security","breakpoints":true}`. 스냅숏 없음(0033·0034와 같다) |
| 구현 | `src/modules/shop/application/create-merch-order.ts`·`merch-payment.ts`·`merch-cancel.ts`·`merch-refund-account.ts`·`merch-return.ts` | 3.3 |
| 구현 | `src/modules/shop/domain/merch-ports.ts`, `adapters/db/drizzle-merch-orders.ts`, `adapters/memory-*.ts`(필요한 만큼) | 대조용 읽기 |
| 구현 | `src/modules/catalog/adapters/db/schema.ts` 517~518행 | 주석 한 줄(역할마다 행 보안, ADR-0337) |
| 시험 | `services/core-svc/test-int/idempotency-rls.int.test.ts`(새) | ①~⑤·⑧ |
| 시험 | `test-int/idempotency-migration.int.test.ts`(새) | ⑦(0040까지 자른 일지 사본, `shop-migration.int.test.ts` 28~48행 꼴) |
| 시험 | `test-int/shop-replay.int.test.ts`(새) | ⑥(AppModule DB 조립, `shop-cancel.int.test.ts`·`shop-order.int.test.ts` 꼴) |
| 계획(이 커밋) | ADR-0337(새), ADR-0241 결정 4·ADR-0146 상태 보충, guidelines §4, authz-matrix §5.3·§7, data.md, asvs/payment 8.2.2, asvs/catalog-review 8.4.1 | 정본 빈칸 먼저 |

- 구현 커밋은 시험 파일을, 시험 커밋은 시험 파일·이 계획 밖을 건드리지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: 적용된 마이그레이션(0002·0004·0027·0033), `packages/platform`, `rls.int.test.ts`·`roles.ts`, 계약·생성물·화면, 파트너·관제 재생 길.

### 6. 시험 목록(시험 담당. 단언 값은 정본에서)

- **준비는 새 칸에 기대지 않는다**: 기록은 각 역할의 실제 연결로 platform `IdempotencyStore.run`을 불러 넣는다(파트너는 `partner.transaction(fn, { tenantId })`). 그래야 구현 전 트리에서도 준비가 돌고 단언에서 실패한다. 시드: 파트너 A·B(판매자·공연), 팬 C·D, 관제 계정 하나와 `ops-contract-change`.
- `loginFor`(`test-int/roles.ts`)로 로그인 사용자를 만들고, 파트너 연결은 연결 하나짜리 풀로 둔다(앞 트랜잭션이 쓴 연결 재사용, rls.int.test.ts 34행 꼴). 42501은 `rejects.toMatchObject({ cause: { code: '42501' } })`. 바꾼 상태는 끝에 `admin`으로 되돌린다. 번호는 `AZ-T17 ①`처럼 ID 바로 뒤에.
- 시험이 기대는 공개 모양: 칸 `tenant_id`, 정책 이름 열 개(결정 3), 일지 idx 41, 맞지 않는 재생은 404 `not-found`(남의 주문과 같은 본문), 로그 `kind` `idempotency-replay-mismatch`·`severity` `SEV2`·`operation`(shop 로거. 시험은 `AppModule.register({ …, shop: { logger } })`로 받는다).

| 파일 | 시험 이름 | 단언 | 구현 전 |
| --- | --- | --- | --- |
| rls | `AZ-T17 ① 파트너 트랜잭션은 조건 없이 읽어도 자기 테넌트의 파트너 작업 기록만 보고 그것만 고친다 [ASVS v5.0.0-8.4.1]` | 테넌트 A의 조건 없는 읽기가 A 기록 둘(등록·회차)과 정확히 같다. WHERE·RETURNING 없는 `set result_ref = '바뀜'` 뒤 `admin`으로 A 둘만 바뀌고 B·팬·관제는 처음 값 | 실패 |
| rls | `AZ-T17 ② 테넌트를 걸지 않은 파트너 트랜잭션과 트랜잭션 밖 읽기는 0건이고 고치기도 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]` | A 트랜잭션을 돈 뒤 테넌트 없는 트랜잭션 읽기 `[]`, 조건 없는 고치기 오류 없이 0행, `partner.db` 읽기 `[]`, `admin`으로 전부 그대로 | 실패 |
| rls | `AZ-T17 ③ 팬 경로 사용자는 조건 없이 읽고 고쳐도 팬 작업 일곱의 기록에만 닿고 지우지 못한다 [ASVS v5.0.0-8.2.2] [ASVS v5.0.0-8.4.1]` | `app` 읽기 = 팬 C·D 기록, 고치기 뒤 팬 기록만 바뀜, 지우기 42501 | 실패 |
| rls | `AZ-T17 ③ 관제 경로 사용자는 조건 없이 읽고 고치고 지워도 관제 작업 둘의 기록에만 닿는다 [ASVS v5.0.0-8.4.1]` | `ops` 읽기 = 관제 기록 둘, 고치기·지우기 뒤 관제 기록만 바뀌고 지워짐(끝에 되살림) | 실패 |
| rls | `AZ-T17 ③ 세 역할은 다른 역할의 작업 이름으로 기록을 넣지 못한다 [ASVS v5.0.0-8.4.1]` | 파트너 `START_MERCH_PAYMENT`·`CREATE_OPS_PROMOTER`, 팬 `CREATE_PRODUCTION`·`CREATE_OPS_PROMOTER_CONTRACT_CHANGE`, 관제 `START_MERCH_PAYMENT`·`CREATE_PRODUCTION_EVENT` 넣기가 값마다 42501 | 실패 |
| rls | `AZ-T17 ④ 세 역할 모두 범위 칸(계정·작업·키)과 테넌트 칸을 칸마다 고치지 못하고 테넌트 칸을 적어 넣지 못한다 [ASVS v5.0.0-8.4.1]` | 역할마다 자기 기록에 `account_ref`·`operation`(목록 안 다른 작업)·`idempotency_key`·`tenant_id`(파트너는 자기 테넌트, 다른 역할은 NULL) 고치기가 칸마다 42501, `tenant_id`를 적은 넣기 42501(3.2 '겹친 가드') | 실패(`tenant_id` 줄은 칸이 없어 42703) |
| rls | `AZ-T17 ⑤ 세 역할의 연결로 낸 처음 요청·같은 키 재요청·다른 지문 요청이 처음 결과·같은 결과·422이고 보관 기간이 지난 키는 다시 처리되며 파트너 기록에만 요청 테넌트가 든다 [ASVS v5.0.0-8.4.1]` | 역할마다 `IdempotencyStore.run`: 처음 `execute` 1회, 같은 키·지문은 `replay`가 처음 참조·`execute` 0회, 다른 지문 422 `idempotency-key-reused`. 가짜 시계로 24시간 − 1ms는 재생, + 1ms는 `execute` 다시 1회(guidelines §4 '보관 기간'). `admin`으로 파트너 기록 `tenant_id` = A, 팬·관제 NULL | 흐름은 통과(있던 동작), `tenant_id` 단언은 칸이 없어 오류 → M12·M13 |
| rls | `AZ-T17 ⑧ 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책 열 개와 작업 목록·칸 권한이 정한 모양이다 [ASVS v5.0.0-8.4.1]` | `relrowsecurity` 참·`relforcerowsecurity` 거짓, 소유자가 세 역할·로그인 사용자 아님. `pg_policies`(`roles::text[]`)가 이름 차례로 결정 3의 열 개(명령·역할). 정책 식의 작업 글을 역할마다 모으면 결정 1과 같고, 합이 `idempotency_record_operation_check` 목록과 같고 겹치지 않는다. 파트너 셋의 식에 `production_partner_tenant` `qual`의 `promoter_id`를 `tenant_id`로 바꾼 글이 든다. `has_column_privilege`로 INSERT는 여섯 칸만, UPDATE는 세 칸만 참 | 실패 |
| migration | `AZ-T17 ⑦ 0040까지 올린 DB의 파트너 기록은 0041 뒤 그 공연·회차의 판매자 테넌트가 들어 그 테넌트에서만 보이고 팬·관제 기록과 JSON이 아닌 기록은 비어 있다 [ASVS v5.0.0-8.4.1]` | 0040까지 올린 DB에 `admin`으로 판매자 A·B, 공연 PA(A)·회차 EA(A), 승인된 공연 PB(B)의 `addedEvents`에 EP, 기록 넷(`{productionId: PA}`·`{eventId: EA}`·`{eventId: EP}`·결과 참조 `x`인 등록)과 팬·관제 하나씩을 넣고 끝까지 올린다. `tenant_id` = A·A·B·NULL, 팬·관제 NULL. A 트랜잭션은 A 둘만, B는 하나만, `x`는 어디에도 없다 | 오류(칸 없음) → M21·M22 |
| replay | `AZ-T17 ⑥ 굿즈 주문·부가 상품 주문의 재생 참조가 다른 팬의 주문이면 404 not-found이고 그 주문 값이 응답에 없다 [ASVS v5.0.0-8.2.2]` | C의 주문(K1)·부가 상품 주문(K2) 뒤 `admin`으로 참조를 D 주문으로 바꿔 같은 키·본문 → 404, 응답에 D 주문 ID 없음, 주문 수 그대로, 로그 요청마다 1줄(`operation` 맞음, 계정 ID·참조 원문 없음). 바꾸기 전 재요청은 처음 201과 같다 | 실패(201) |
| replay | `AZ-T17 ⑥ 결제 시도 재생의 시도 ID·결제사·금액이 경로 주문과 맞지 않으면 404 not-found이고 결제사를 부르지 않으며 바꾸지 않은 재요청은 처음 응답과 같다 [ASVS v5.0.0-8.2.2]` | C 주문 O1 결제 시도(K3) 뒤 JSON을 하나씩 바꿔(가 시도 ID를 C의 다른 주문 O2 시도로, 나 결제사, 다 금액 + 1,000원, 라 JSON 아닌 글) 다시 보내면 각각 404, 결제창 준비 호출·시도 수 그대로, 로그 1줄씩. 바꾸기 전 재요청은 처음 응답과 바이트까지 같다 | 실패(바꾼 JSON) |
| replay | `AZ-T17 ⑥ 결제 접수 재생 참조가 목록 밖 값이면 404 not-found이고 승인 명령이 없다 [ASVS v5.0.0-8.2.2]` | 접수(K4) 뒤 참조를 두 값 밖의 글(`ACCEPTED`, `x`)로 바꾸면 각각 404, 승인 명령·`merch_confirm_job` 수 그대로. `accepted`면 202 | 실패(202) |
| replay | `AZ-T17 ⑥ 취소·환급 계좌 다시 받기 재생의 취소 ID가 다른 주문의 것이면 404 not-found이고 결제사 취소가 없다 [ASVS v5.0.0-8.2.2]` | 취소(K5)는 참조를 D 주문의 취소로 바꾸고, 계좌 다시 받기는 platform `requestFingerprint`로 지문을 만든 기록을 `admin`으로 넣어(재생 길이 맨 먼저 보므로 처음 요청이 없어도 된다) 다른 주문의 취소를 가리키게 한다 → 각각 404, 취소 호출·`merch_refund` 수 그대로 | 실패(그 취소의 202) |
| replay | `AZ-T17 ⑥ 반품 재생 참조가 같은 팬의 다른 주문이면 404 not-found이고 그 주문 상세가 응답에 없다 [ASVS v5.0.0-8.2.2]` | 반품(K6, O1) 뒤 참조를 `return:{O2}`로 → 404, 응답에 O2 없음 | 실패(O2 상세) |

- 회귀(게이트에서 돈다): `registration.int`(core_partner 등록·같은 키), `shop-order.int`·`shop-cancel.int`·`shop-refund-account.int`·`shop-return.int`(core_app, 같은 키 재요청), `promoter-contract.int`(core_ops, RV-03 재생·예약 풀기 지우기), `rls.int`(W12-core-rls), `test/migrations-journal.test.ts`, `test/promoter-contract.migration.test.ts`.

### 7. 실패 확인(시험 담당)

- **어디서**: W12-core-rls가 develop에 든 뒤 rebase하고, 시험 커밋을 이 계획 커밋 위에 쌓은 트리(0041 없음).
- **차례**: `docker info` → `bash D:/ticketpass-locks/lock.sh take docker lane2-W12-core-idem`(남이 쥐었으면 `who`를 적고 감독에게 알림) → `pnpm exec turbo run build --filter=@peaket/core-svc^...` → `pnpm --filter @peaket/core-svc test:integration test-int/idempotency-rls.int.test.ts test-int/idempotency-migration.int.test.ts test-int/shop-replay.int.test.ts` → 자기 컨테이너만 `docker rm -f -v` → `lock.sh drop docker lane2-W12-core-idem`.
- **기대**: ①②③④⑥⑧ **단언 실패**. ⑤의 `tenant_id` 단언, ④의 `tenant_id` 줄, ⑦은 칸이 없어 오류다. '바탕이 구현 몫'이라 세지 않고 M10·M12·M13·M21·M22로 실패를 본다(§8.6 7).
- **적을 것**: 명령, 파일마다 통과·실패 수, 실패마다 실제 값 한 줄, 세지 않은 실패와 그 표본 번호, 잠금 시각.

### 8. 틀린 구현 표본(검증 담당, 23개, 항목마다 1개 이상)

기준선은 구현 뒤 트리에서 새 파일 셋과 회귀 통과. 표본마다 하나만 넣고 돌린 뒤 `git checkout -- <파일>`. 0041을 바꾸는 표본은 파일마다 새 컨테이너에 다시 올리므로 그대로 걸린다.

| # | 항목 | 넣을 곳 | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- | --- |
| M1 | ① | 0041 | 파트너 읽기 정책에서 테넌트 식을 뺀다 | ①⑦⑧ |
| M2 | ① | 0041 | 파트너 고치기 USING을 작업 목록만으로 | ①⑧ |
| M3 | ② | 0041 | 파트너 정책 셋에서 `nullif`를 뺀다 | ②(연결 재사용 22P02) |
| M4 | ② | 0041 | 파트너 읽기를 `tenant_id = coalesce(nullif(…)::uuid, tenant_id)`로 | ②⑧ |
| M5 | ③ | 0041 | 팬 읽기 USING `true` | ③⑧ |
| M6 | ③ | 0041 | 팬 넣기 WITH CHECK `true` | ③⑧ |
| M7 | ③ | 0041 | 관제 지우기 USING `true` | ③⑧ |
| M8 | ③ | 0041 | `START_MERCH_PAYMENT`를 관제 목록에도 넣는다 | ③⑧ |
| M9 | ④ | 0041 | `REVOKE … UPDATE`를 빼 표 단위 고치기를 남긴다 | ④⑧ |
| M10 | ④ | 0041 | 넣기 칸 권한에 `tenant_id`를 더한다 | ④⑧ |
| M11 | ① | 0041 | 파트너 정책 셋의 설정 이름을 `app.tenant`로 | ①②⑤, `registration.int` |
| M12 | ⑤ | 0041 | 고치기 칸 권한에서 `created_at`을 뺀다 | ⑤, 회귀 전부(모든 첫 요청 42501) |
| M13 | ⑤ | 0041 | `tenant_id`를 기본값 없이 더한다 | ⑤⑦, `registration.int` |
| M14 | ⑥ | `create-merch-order.ts` | `#replayView`의 계정 대조를 뺀다 | ⑥ 주문·부가 상품 |
| M15 | ⑥ | `merch-payment.ts` | 시작 재생에서 시도가 경로 주문의 것인지 보지 않는다 | ⑥ 결제 시도 가 |
| M16 | ⑥ | `merch-payment.ts` | 시작 재생의 금액 대조를 뺀다 | ⑥ 결제 시도 다 |
| M17 | ⑥ | `merch-payment.ts` | 접수 재생이 목록 밖 값을 `accepted`로 본다 | ⑥ 결제 접수 |
| M18 | ⑥ | `merch-cancel.ts` | 취소 행의 주문 대조를 뺀다 | ⑥ 취소 |
| M19 | ⑥ | `merch-refund-account.ts` | 같은 대조를 뺀다 | ⑥ 계좌 다시 받기 |
| M20 | ⑥ | `merch-return.ts` | 경로 주문 대조를 뺀다 | ⑥ 반품 |
| M21 | ⑦ | 0041 백필 | 회차 더하기 백필을 뺀다 | ⑦ |
| M22 | ⑦ | 0041 백필 | 변경분 회차(`addedEvents`) 백필을 뺀다 | ⑦ |
| M23 | ⑧ | 0041 | `FORCE ROW LEVEL SECURITY`를 더한다 | ⑧만(`admin`은 슈퍼유저라 FORCE도 건너뜀) |

- 항목마다 수: ① 3, ② 2, ③ 4, ④ 2, ⑤ 2, ⑥ 7(재생 자리마다), ⑦ 2, ⑧ 1. 정책 식 칸 이름을 틀리면 0041이 42703으로 멈춰 모든 통합 시험이 멈추므로 세지 않는다. 장애 주입은 해당 없음(복구 경로가 없는 권한 변경·읽기 대조). 로그를 빼는 변이는 ⑥이 로그를 단언해 따로 세지 않는다.
- '검증' 절에 적을 것: 표본마다 실패한 시험, 놓친 표본과 넘긴 것, AZ-T17 ①~⑧ 판정 기준과 단언의 대조 전수.

### 9. 게이트 명령과 닿는 CI 잡

```bash
cd /d/ticketpass-lane2
pnpm exec turbo run build --filter=@peaket/core-svc^...
pnpm --filter @peaket/core-svc typecheck
pnpm --filter @peaket/core-svc test                     # 단위 전부(0041 when 포함)
# Docker 잠금을 잡고, 합치기 직전 develop 위로 다시 쌓은 트리에서
PEAKET_TEST_REPORT=test-report-int.json pnpm --filter @peaket/core-svc test:integration   # 통합 전부(ADR-0283 결정 3)
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "AZ-T17, v5.0.0-8.2.2, v5.0.0-8.4.1" --report services/core-svc/test-report-int.json
node tools/ci/roles-check.mjs --base origin/develop --head feature/lane2-W12-core-idem   # 감독이 합치기 직전
```

- 닿는 잡: `ci-node.yml` / node(core typecheck·단위·통합), `docs-check` / docs, `lint-guard`(shop 응용 층·저장소 포트).
- 장부: BUILD_ORDER 묶음이 아니라 `ledger.mjs --batch`는 쓰지 않는다. 지금 `node tools/ci/ledger.mjs --scope AZ-T17`은 항목 8개·빈칸 8·등급 B(원천 authz-matrix)다. 이 묶음은 감독 결정으로 A로 증명한다. 기록 담당이 `node tools/ci/ledger.mjs`로 다시 쓰고 AZ-T17 ①~⑧이 '자동 시험'인지 본다.
- `pnpm`이 막히면 `npx tsc -p services/core-svc/tsconfig.json --noEmit`, `npx vitest run --config vitest.integration.config.mjs <파일>`(core-svc 폴더). 통합 전부는 Docker 차례가 길면 초안 PR CI로.
- 리뷰(보안): 정책 식과 작업 목록(결정 1과 CHECK), REVOKE·GRANT 차례, 백필 변환 안전, FORCE·소유자, N-1(3.4), 재생 대조가 쓰기·바깥 호출보다 앞인가, 로그에 계정·참조 원문이 없나, 시험이 앱 쿼리 조건 없이 행 보안만 보는가.

### 10. 자주 놓친 결함 가운데 해당하는 것

- 정확한 값까지: ①③ 보이는 기록 목록 전체, ⑤ `execute` 횟수·재생 참조, ⑦ 기록마다 테넌트 값.
- 경계 양쪽: ⑤ 보관 기간 24시간 − 1ms·+ 1ms(값은 guidelines §4). 세 상태: 테넌트 있음(①)·없음·빈 문자열(② 연결 재사용).
- 겹친 가드 하나씩: 칸 권한과 WITH CHECK(④), DB 행 보안과 앱 대조(⑥은 `admin`으로 바꿔 앱만).
- 목록 밖 값마다: ③ 역할마다 다른 작업 둘, ④ 칸마다, ⑥ 접수의 목록 밖 값 둘. 계정 대조를 뺀 요청: ⑥ 전부.
- 부르는 쪽이 결과를 쓰는지: ⑥은 HTTP로 보고 결제사 호출·DB 쓰기 0건을 단언한다. 시험 값은 상수와 다르게(금액 + 1,000원).

### 11. 범위 밖

같은 역할 안의 계정 묶기(OPEN-A), 결제창 값을 저장하지 않는 재생(OPEN-B), 파트너·관제 재생 대조(결정 6 끝), 정비 연결 역할(감독에게 3), 아래 14의 표, 플랫폼 `IdempotencyStore`·다른 서비스의 멱등 기록 표.

### 12. WBS 일 [가정]

1.8일 = 계획 0.2 + 시험 0.5(새 통합 파일 셋, HTTP 조립 하나) + 구현 0.4(마이그레이션·재생 대조 여섯 자리·저장소 읽기) + 리뷰 0.2 + 검증 0.4(표본 23개) + 기록 0.1. 감독이 coord.md에 적는다.

### 13. OPEN 문안 후보(감독 결정 대기)

> **OPEN-A(다음 번호)** core-svc 멱등 기록의 같은 역할 안 계정 묶기(W12-core-idem이 남김, ADR-0337 '남는 한계'). 0041 뒤에도 팬끼리·같은 테넌트의 파트너 계정끼리는 DB가 기록을 가르지 않아, 팬 경로 쿼리 하나가 다른 팬의 굿즈 재생 응답을 읽거나 바꿀 수 있다(재생 대조는 '다른 자원을 가리키게 바꾸기'만 잡는다).
> (가) 추천: 두 번에 나눠 낸다. 1단계로 플랫폼 `IdempotencyStore`가 키를 잡는 트랜잭션에 계정 값을 걸고(`set_config`, 정책 없음) 굿즈 `replayOf`를 그 값을 건 읽기 트랜잭션으로 바꾼다. 다음 배포에서 그 값으로 팬·파트너 정책을 좁힌다(같이 내면 이전 판이 값을 걸지 않아 배포 창 동안 멱등 쓰기가 모두 거절된다). 새 묶음(B, 보안 중간), 플랫폼을 바꿔 다른 서비스 시험도 돈다.
> (나) 그대로 두고 구간 끝 정리 목록에 남는 위험으로 적는다.

> **OPEN-B(다음 번호)** 굿즈 결제 시도의 결제창 값을 DB에 두지 않는 재생(W12-core-idem이 남김). `START_MERCH_PAYMENT`의 결과 참조는 결제창 값(결제사 공개 키·구매자 키·금액·돌아올 주소)을 통째로 담고 재생이 그대로 돌려준다. 재생 대조는 시도·결제사·금액만 보므로, 공개 키나 돌아올 주소의 출처가 바뀌면 팬이 다른 상점의 결제창으로 갈 수 있다. 티켓 결제 시도는 이미 시도 ID와 결제사로 다시 만든다(guidelines §4 '예외 둘째', 데이터 최소화).
> (가) 추천: 굿즈도 같은 꼴로. 결과 참조에 시도 ID만 두고 재생 때 `PrepareCheckout`을 같은 시도 ID로 다시 불러 만든다(실패하면 5xx, 같은 키로 다시). 새 묶음(A, 굿즈 결제)이고 '예외 둘째'의 범위를 넓히는 정본 고침이 든다.
> (나) 그대로 두고 남는 위험으로 적는다(다른 역할의 변조는 이 묶음의 행 보안이 막는다).

### 14. 다른 표 목록(감독 요청, 고치지 않음)

core-svc 0000~0034의 GRANT·행 보안을 표마다 대조했다('여러 역할'은 권한이 있는 앱 역할이 둘 이상).

| 표 | 누가 읽고 쓰나 | 위험 한 줄 |
| --- | --- | --- |
| `production_artist`·`search_alias` | `core_partner` 넣기, `core_app` 읽기(0004) | 행 보안이 없어 파트너 경로 쿼리 하나로 다른 파트너 공연에 출연진·다른 이름을 붙여 검색·상세에 보인다. 중간(W12-core-rls 정리 후보 (나)) |
| `held_event` | `core_app` 읽기·넣기·`reprocessed_at` 고치기(0022·0026), `core_maintenance` 읽기·지우기(0022) | 공용 보류 표. 팬 경로 쿼리 하나가 남의 보류 행을 '다시 처리함'으로 고치면 정비가 지워 사건을 잃는다. 낮음 |
| `review`·`takedown_action` | `core_app` 읽기·넣기·칸 고치기(0022), `core_maintenance` 칸 읽기·고치기(0022·0026) | 작성 계정 대조는 앱만. 팬 경로 쿼리 하나가 다른 팬 후기의 상태·본문을 고친다. 낮음~중간 |
| `search_document`·`search_term`·`search_removal`·`search_version` | `core_ops` 읽기·쓰기, `core_search` 읽기, `core_app` `search_document` 읽기(0023) | 공개 자료라 테넌트가 없다. 관제 경로 쿼리 하나가 승인 전 공연을 검색에 올릴 수 있다. 낮음 |
| `place`·`artist` | `core_partner`·`core_app` 읽기(0004) | 공용 기준 자료, 앱 역할 쓰기 없음. 거의 없음 |
| (행 보안 있음) `webhook_endpoint` | `core_partner` 테넌트 정책(0015), `core_app` **표 단위 고치기**·조건 없는 `webhook_endpoint_app_write`(0016) | 팬 경로 역할이 모든 파트너의 웹훅 주소·상태를 고칠 수 있어, 쿼리 하나로 파트너 사건이 다른 곳으로 간다. **높음 후보** |
| (행 보안 있음) `merch_order`·`merch_order_item` | `core_partner` **표 단위 고치기**+테넌트 정책, `core_app` 조건 없는 `FOR ALL`(0016) | 파트너 경로 쿼리 하나가 자기 테넌트 항목의 단가·수수료율·상태를 고치고 상품 정산 원천(`drizzle-merch-store.ts` `listSettlementItems`)이 그 값을 읽는다. 파트너 코드가 이 표를 고치는 곳은 못 찾았다. **높음 후보(돈)** |
| (역할 하나) `merch_payment_attempt`·`merch_confirm_job`·`merch_refund`·`merch_refund_item` | `core_app` 읽기·넣기·고치기·지우기(0027·0030) | 역할 사이 꼴은 아니나 돈 표에 지우기까지 있고 계정·테넌트를 DB가 보지 않는다. 낮음 |

## 실패 확인

시험 담당(세션 `lane2-w12coreidem-test`)이 2026-11-22에 썼다. 시험 커밋 `7b098a661`(이 계획 커밋 위, 0041·재생 대조 없음).

- **어디서·왜 위 7과 다른가**: 감독이 정한 Docker 차례(갈래 1·4 먼저)로 로컬 Docker를 쓰지 않았고, W12-core-rls가 아직 develop에 없어 rebase하지 않았다. 바탕은 `456df0929`(develop) + 계획 커밋 + 시험 커밋이고, 초안 PR CI(peaket/peaket #57, `ci` 실행 44932045387, `node / node` 잡)의 `pnpm --filter @peaket/core-svc test:integration` 단계로 봤다. 잠금은 잡지 않았다(로컬 컨테이너 없음).
- **정적 검사(로컬)**: `pnpm exec turbo run build --filter=@peaket/core-svc^...`, `pnpm --filter @peaket/core-svc typecheck`(시험 포함) 통과, `pnpm lint` 통과. 새 단위 시험은 없다(계획 6이 정하지 않음).
- **결과**: core-svc 통합 `Test Files 5 failed | 45 passed | 1 skipped (51)`, `Tests 17 failed | 473 passed | 1 skipped (491)`. 17개 가운데 새 시험이 14개이고, 나머지 셋(`rls.int.test.ts` AZ-T5 '코드가 쓰지 않는 표는 읽지 못한다'·'다른 공연을 지우거나 판매자 표를 고칠 권한이 없다', `search-read-model.int.test.ts` R165-1)은 W12-core-rls가 develop에 없어 원래 실패하는 것이라 이 묶음 결과에서 뺐다. 건너뛴 1개는 이 묶음 밖의 기존 시험이다.

| 파일 | 시험 | 결과 | 실제 값(한 줄) |
| --- | --- | --- | --- |
| rls | AZ-T17 ① | 단언 실패 | 테넌트 A 트랜잭션의 조건 없는 읽기가 기록 12개 전부(기대 A의 2개) |
| rls | AZ-T17 ② | 단언 실패 | 연결 재사용(설정 값 `''` 확인) 뒤 테넌트 없는 트랜잭션이 12개를 보고 12행을 고침(기대 0·0) |
| rls | AZ-T17 ③ 팬 | 단언 실패 | `core_app` 조건 없는 읽기 12개(기대 팬 작업 일곱의 7개) |
| rls | AZ-T17 ③ 관제 | 단언 실패 | `core_ops` 조건 없는 읽기 12개(기대 관제 2개) |
| rls | AZ-T17 ③ 넣기 | 단언 실패 | 파트너의 `START_MERCH_PAYMENT` 넣기가 성공(기대 42501) |
| rls | AZ-T17 ④ | 단언 실패 | 파트너의 `account_ref` 고치기가 성공(기대 42501). `tenant_id` 줄까지는 가지 않았다 |
| rls | AZ-T17 ⑤ | 오류(세지 않음) | 처음·재요청·422·24시간 − 1ms 재생·+ 1ms 다시 처리까지 세 역할 모두 통과한 뒤 `tenant_id` 읽기가 42703(칸 없음). 바탕이 구현 몫 → M12·M13으로 본다 |
| rls | AZ-T17 ⑧ | 단언 실패 | `relrowsecurity` 거짓(기대 참) |
| migration | AZ-T17 ⑦ | 오류(세지 않음) | 0040까지 자른 사본(지금 트리는 0034까지)으로 올리고 옛 기록 일곱을 넣는 준비는 돌았고, 끝까지 올린 뒤 `tenant_id` 읽기가 42703. 바탕이 구현 몫 → M21·M22로 본다 |
| replay | AZ-T17 ⑥ 주문·부가 상품 | 단언 실패 | 바꾸지 않은 재요청은 처음 201과 바이트까지 같았고, 참조를 D 주문으로 바꾼 재요청이 201(기대 404 not-found) |
| replay | AZ-T17 ⑥ 결제 시도 | 단언 실패 | 바꾸지 않은 재요청은 처음 201과 같았고, (가) 시도 ID를 같은 팬 다른 주문의 시도로 바꾼 재요청이 201 |
| replay | AZ-T17 ⑥ 결제 접수 | 단언 실패 | 바꾸지 않은 재요청 202, 참조 `ACCEPTED` 재요청이 202(기대 404) |
| replay | AZ-T17 ⑥ 취소·계좌 다시 받기 | 단언 실패 | 바꾸지 않은 재요청 202, 참조를 D 주문의 취소로 바꾼 취소 재요청이 202 |
| replay | AZ-T17 ⑥ 반품 | 단언 실패 | 바꾸지 않은 재요청 200, 참조를 `return:{같은 팬 다른 주문}`으로 바꾼 재요청이 200 |

- **까닭**: 모두 계획 7의 기대와 같다. 행 보안·칸 권한·`tenant_id` 칸(0041)과 shop 재생 대조가 아직 없어서다. ①②③④⑧⑥은 단언에서, ⑤⑦은 칸이 없어 오류로 끝났다(계획 7 '세지 않는다', 검증의 M12·M13·M21·M22가 맡는다).
- **구현 전 트리에서 돌지 않은 부분**(앞 단언이 먼저 실패해서): ⑥ 부가 상품 줄, 결제 시도 (나)~(라), 결제 접수 `x`와 `accepted`로 되돌리기, 취소의 '같은 팬 다른 주문의 취소'와 계좌 다시 받기 전부(지문을 맞춘 기록·맞는 참조 `cancel:{그 주문의 취소}`의 202 포함), ③ 넣기의 나머지 다섯, ④의 팬·관제 줄과 `tenant_id` 줄, ⑦의 테넌트 값. 구현 뒤 첫 실행에서 준비 단계가 깨지면(예: 계좌 다시 받기가 422 `idempotency-key-reused`) 시험 결함이니 시험 담당에게 돌린다.
- **계획 6보다 더 본 것(정본 안)**: ⑦에 결과 참조가 JSON이지만 ID가 UUID 꼴이 아닌 기록(`{"eventId":"not-a-uuid"}`)을 더했다(결정 2 '변환 오류로 멈추지 않게'). ⑥ 취소·계좌 다시 받기에 '같은 팬 다른 주문의 취소'를 더했다(계정 대조만 남은 M18·M19도 잡게). ⑧에 표 단위 넣기·고치기가 없고 읽기는 표 단위·지우기는 관제만인지(결정 4), `core_maintenance`·`core_search`에 권한이 없는지(결정 3), 팬·관제 정책 식에 `app.tenant_id`가 없는지(결정 3)를 더했다.
- **구현 담당이 알 것**: ⑥ 404 본문은 다른 계정이 그 주문을 읽을 때의 404와 `status`·`type`·`title`이 같아야 한다. 로그는 맞지 않는 요청마다 `error` 한 줄(`kind`·`severity` `SEV2`·`operation`, 경로에 주문이 있는 다섯 작업은 `orderId` = 경로 주문)이고, 줄 전체에 세션·상대 계정 ID와 결과 참조 원문(주문 만들기에서는 참조한 주문 ID)이 없어야 한다. 바꾸지 않은 재요청에는 이 로그가 없어야 한다. 결제 시도 (나)는 `pg`를 `TOSS`로 바꾼다(시도의 결제사는 `SIMULATOR`).

## 시험 결과

(시험 담당이 구현 뒤 트리의 결과를 쓴다.)

## 구현

(구현 담당이 쓴다.)

## 리뷰

(리뷰 담당이 보안 관점으로 쓴다.)

## 검증

(검증 담당이 위 8의 표본 결과를 쓴다.)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane2-w12coreidem-plan | claude-opus-5-5 | 2026-11-22T01:45+09:00 | 2026-11-22T02:24+09:00 |
| test | lane2-w12coreidem-test | claude-opus-5-5 | 2026-11-22T02:25+09:00 | 2026-11-22T03:12+09:00 |

## 기록

(기록 담당이 쓴다.)

- **다음 단계**: W12-core-rls가 develop에 합쳐진 뒤 이 가지를 rebase하고, 구현 담당이 위 3·5대로 0041과 shop 재생 대조를 넣어 새 시험 파일 셋(AZ-T17 ①~⑧ 14개)과 위 6의 회귀를 통과시킨다.
