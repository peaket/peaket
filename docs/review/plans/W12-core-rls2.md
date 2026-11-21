# 작업 계획: W12-core-rls2(웹훅 끝점·굿즈 주문의 앱 역할 쓰기 권한 좁히기)

- **무엇**: core-svc 두 군데의 DB 쓰기 권한이 너무 넓다. (1) 웹훅 끝점 표 `webhook_endpoint`(파트너가 사건을 받을 주소와 서명 비밀을 적은 표)는 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)이 있지만, 0016이 팬 경로 역할 `core_app`에 표 단위 고치기와 조건 없는 정책을 줬다. 팬 경로 쿼리 하나로 모든 파트너의 웹훅 주소·비밀을 바꿀 수 있다. (2) 굿즈 주문 표 `merch_order`·`merch_order_item`은 0016이 파트너 역할 `core_partner`에 표 단위 넣기·고치기를 줬다. 자기 테넌트(파트너사 하나의 데이터 범위) 주문의 단가·수수료율·상태를 고치거나 결제 안 된 주문을 넣을 수 있고, 상품 정산 원천이 그 값을 그대로 읽는다(돈). 감독 결정(2026-11-22, W12-core-idem 계획의 '다른 표 목록'에서 나온 높음 둘): 등급 A처럼 한다(시험 먼저, 틀린 구현은 판정 항목마다, 리뷰는 보안 관점). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-b176`, 가지 `feature/lane2-W12-core-rls2`, 출발점 `origin/develop` `e43bc2633`(계획을 쓰는 동안 `456df0929`에서 앞으로 감았다. core-svc 마이그레이션 마지막은 그대로 `0034_sale_review_request`, journal `when` 1795118255889). 2026-11-22 계획 담당(세션 `lane2-w12corerls2-plan`)이 썼고 제품·시험 코드는 쓰지 않았다. 마이그레이션 **0042**·ADR **0338**은 감독이 나눈 번호다.
- **앞 묶음**: W12-core-rls(가지 `origin/feature/lane2-W12-core-rls`, 0040 `promoter` 행 보안, ADR-0327에 그 가지가 더하는 결정 13)와 W12-core-idem(가지 `origin/feature/lane2-W12-core-idem`, 0041 `idempotency_record`, 그 가지에만 있는 새 ADR 0337번). 두 계획과 0040은 `git show`로 읽었다. 이 묶음은 둘이 develop에 합쳐진 뒤 rebase해 시험·구현한다. 정책 꼴(명령마다 나눈 정책, `app.tenant_id`와 `nullif`, 칸 단위 GRANT, `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`, FORCE 없음)은 두 묶음과 같다.
- **차례**: 시험 먼저. 계획 → 시험(구현 전 트리에서 실패 확인) → 구현 → 리뷰(보안) → 리뷰 반영 → 검증(틀린 구현 18개) → 기록. 계획 커밋에 `Batch-Order`를 달지 않는다(docs/architecture.md §8.6 '차례').
- **정본**: [ADR-0338](../../adr/0338-core-webhook-endpoint-merch-order-write-grants.md)(새로 씀), [ADR-0241](../../adr/0241-core-svc-partner-row-security.md) 결정 1·3·4·6·7, [authz-matrix](../../security/authz-matrix.md) §3.3·§5.3(새 줄)·§7 **AZ-T18**(새 시험 ID), [data.md](../../data.md) `webhook_endpoint.disabled_reason`·`merch_order_item.unit_price`·`commission_rate_bp`, [asvs/notify](../../security/asvs/notify.md) 8.4.1, [asvs/settlement](../../security/asvs/settlement.md) 8.2.3, [notify.md](../../features/notify.md) §9·§13, [settlement.md](../../features/settlement.md) §4.5, ADR-0300 결정 9.

## 감독에게

1. **로컬 재현은 하지 않았다.** 지시대로 Docker를 쓰지 않았다(갈래 1·4 차례). 잠금·컨테이너는 건드리지 않았다. 위험은 마이그레이션 원문과 코드 경로로 세웠다(아래 2). 시험 담당의 실패 확인(7)이 첫 실행이고, Docker 차례가 오지 않으면 초안 PR CI로 본다.
2. **겹치는 파일**(두 앞 묶음이 먼저 합쳐지고 이 가지가 rebase한다):
   - `services/core-svc/migrations/meta/_journal.json`: W12-core-rls idx 40(`when` 1795281728010), W12-core-idem idx 41, 이쪽 idx 42. 0042의 `when`은 0040·0041과 구현 직전 develop 마지막 `when`보다 커야 한다(`test/migrations-journal.test.ts`). 0035~0039(갈래 3·5 몫)가 뒤에 합쳐지면 그쪽이 다시 매긴다.
   - `test-int/rls.int.test.ts`(W12-core-rls가 고침): **고치지 않는다.** 새 시험은 새 파일 하나에 둔다(아래 6).
   - `docs/security/authz-matrix.md` §7: W12-core-idem의 AZ-T17 줄과 이쪽 AZ-T18 줄이 develop의 AZ-T16 줄 바로 뒤 같은 자리에 들어가 rebase 때 충돌이 난다. 두 줄을 다 남기고 AZ-T17 → AZ-T18 차례로 둔다. §5.3은 W12-core-rls가 'core-svc 구현' 줄을, W12-core-idem이 'ops-svc 구현' 줄 뒤에 새 줄을 더하고, 이쪽은 '비용과 확인' 줄 뒤에 더해 붙지 않는다.
   - `docs/data.md`(앞 묶음은 `promoter.id`·멱등 기록 표 문단, 이쪽은 1744·1745·1810행), `docs/security/asvs/settlement.md`(W12-core-rls는 8.4.1, 이쪽은 8.2.3): 붙지 않은 줄이라 충돌이 없을 것이다. ADR-0241은 이쪽이 고치지 않는다.
   - 자기 작업 가지의 강제 푸시(`--force-with-lease`)가 세션 권한 판정에 막히므로(docs/lanes/lane5-cleanup.md 21행) rebase한 가지는 `feature/lane2-W12-core-rls2-r2`로 새로 올리고, 초안 PR도 그 가지로 다시 연다.
3. **판단 둘(방향 안, 확인 바람)**:
   - 파트너의 굿즈 주문 '필요한 칸'은 **0개**다. 파트너 코드가 두 표를 쓰는 곳이 없다(배송·반품 처리 서버가 아직 없다, 1.4). 그래서 칸 고치기를 하나도 남기지 않고, 계약의 전이가 쓸 칸과 끝까지 주지 않을 칸의 선을 ADR-0338 결정 4에 적었다.
   - 지시는 '표 단위 UPDATE를 거둔다'였지만 같은 GRANT 줄(0016 71행)의 **INSERT도 거둔다**. 결제 끝남(`PAID`) 주문을 넣으면 정산에 그대로 오르므로 고치기와 같은 돈 위험이다(2의 R6).
4. **새 ADR-0338**(결정 1~7): 발송기 몫(읽기 그대로, 고치기는 켜진 끝점을 `FAILING`으로 끄는 세 칸만), 파트너 웹훅 칸 아홉, 파트너 굿즈 주문 읽기만, 파트너 쓰기 경로를 만들 때의 선, FORCE 없음, 이전 판 호환, 0042. 0338 말고 번호는 쓰지 않았다.
5. **새 시험 ID AZ-T18**(authz-matrix §7, ①~⑦). 계획 커밋 직전 develop과 원격 가지 전부에 AZ-T18이 없음을 봤다(AZ-T17은 W12-core-idem 몫). `node tools/ci/ledger.mjs --scope AZ-T18`은 항목 7·빈칸 7·등급 B다.
6. **OPEN 문안 후보 하나**(13): 발송기 전용 DB 역할. 팬 경로 역할이 웹훅 비밀을 읽고 발송 원장에 꾸민 행을 넣을 수 있는 남는 위험을 함께 닫는다.
7. **새로 찾은 표**(14, 고치지 않음): 높음 후보 둘 — `webhook_delivery`(팬 경로 역할의 조건 없는 쓰기 → 파트너 비밀로 서명된 꾸민 사건), `product.commission_rate_bp`(파트너 역할의 표 단위 고치기 → 이후 주문 항목의 수수료율). 둘째는 이 묶음이 지키는 주문 항목 수수료율의 한 단계 앞이라 ADR-0338 '남는 한계'에도 적었다.
8. **WBS 일 [가정] 1.3일**(12).

## 계획

### 1. 조사 결과

#### 1.1 표·권한·정책(지금, 0034까지. 두 앞 묶음은 이 두 표를 건드리지 않는다)

| 표 | 역할 | 권한(마이그레이션 행) | 정책 |
| --- | --- | --- | --- |
| `webhook_endpoint` | `core_partner` | `SELECT, INSERT, UPDATE` 표 단위(0015 36행) | `webhook_endpoint_partner_tenant` FOR ALL, USING·WITH CHECK 테넌트 식(0015 42행) |
| | `core_app` | `SELECT`(0004 25행 기본 권한 `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES`), **`UPDATE` 표 단위(0016 79행)** | `webhook_endpoint_app_read` FOR SELECT `true`(0015 50행), **`webhook_endpoint_app_write` FOR UPDATE `true`/`true`(0016 107행)** |
| `merch_order`·`merch_order_item` | `core_partner` | **`SELECT, INSERT, UPDATE` 표 단위(0016 71행)** | `merch_order_partner_tenant`·`merch_order_item_partner_tenant` FOR ALL 테넌트 식(0016 87·91행) |
| | `core_app` | `SELECT`(기본 권한), `INSERT, UPDATE`(0016 75행) | `merch_order_app_all`·`merch_order_item_app_all` FOR ALL `true`/`true`(0016 99·101행) |
| 세 표 | `core_ops`·`core_maintenance`·`core_search` | 없음 | 없음 |

- 행 보안은 세 표 모두 켜져 있고 FORCE는 없다(0015 38행, 0016 81·83행). 테넌트 식은 `promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid`(0004 `production_partner_tenant`와 같은 글).
- 시험의 기존 단언: `shop-notify.int.test.ts` 95행(0014·0015 권한)과 257행(0016 권한)이 `information_schema.role_table_grants`(표 단위 권한만 보인다)로 `core_partner` 웹훅 `INSERT,SELECT,UPDATE`, 굿즈 주문 둘 `INSERT,SELECT,UPDATE`, `core_app` 웹훅 끝점 `SELECT,UPDATE`를 본다. 0042 뒤 모양이 달라져 시험 담당이 고친다(6).

#### 1.2 읽고 쓰는 코드 경로(전부, `grep -rn "webhookEndpoint\|webhook_endpoint\|merchOrder\|merch_order" services/core-svc/src services/core-svc/scripts`)

**`webhook_endpoint`** — 저장소 하나(`notify/adapters/db/drizzle-webhook-store.ts`)를 두 연결로 조립한다(`notify.module.ts` 46·47행, `main.ts` 249행).

| 역할(연결) | 메서드(행) | 문장 | 읽는 칸 | 고치는 칸 |
| --- | --- | --- | --- | --- |
| `core_partner`(`PEAKET_PARTNER_DATABASE_URL`, 테넌트 트랜잭션) | `listEndpoints`(40)·`findEndpoint`(50)·`listDeliveries`(105)·`findDelivery`(119)·`redeliver`(134) | SELECT `promoter_id = 테넌트` | 모든 칸 | — |
| 〃 | `insertEndpoint`(60) | INSERT | — | 11칸 전부 |
| 〃 | `saveEndpoint`(81) | UPDATE … WHERE id·promoter_id·version RETURNING | 모든 칸 | `url`·`event_types`·`status`·`disabled_reason`·`secret`·`previous_secret`·`secret_issued_at`·`previous_secret_valid_until`·`version`(**아홉**, `id`·`promoter_id`는 없음) |
| `core_app`(`PEAKET_DATABASE_URL`, 발송기) | `listActiveEndpoints`(156) | SELECT `promoter_id = $1 AND status = 'ACTIVE'`(테넌트 없음) | 모든 칸(주소·비밀 포함) | — |
| 〃 | `findEndpointById`(163) | SELECT `id = $1` | 모든 칸 | — |
| 〃 | `disableEndpoint`(251) | `UPDATE … SET status='DISABLED', disabled_reason='FAILING', version = version + 1 WHERE id = $1` | `id`·`version`(SET 식) | `status`·`disabled_reason`·`version`(**셋**) |

- 파트너 유스케이스(`notify/application/webhooks.ts`): 등록·목록·고치기(If-Match)·비밀 재발급·발송 이력·다시 보내기. 상태를 `ACTIVE`로 다시 켜는 것도 파트너 고치기다(84행, notify.md §9).
- 발송기(`notify/application/dispatcher.ts`): `enqueue`(내부 입구 `POST /internal/v1/notify/webhook-events`와 같은 길)가 켜진 끝점을 읽고 발송 행을 넣는다. `processDue`가 끝점을 다시 읽어(78행) 꺼졌으면 DEAD, 켜졌으면 지금 비밀·옛 비밀로 서명해 보낸다(87행). DEAD가 기준을 넘으면 `disableEndpoint`(118행). 이 표를 고치는 `core_app` 코드는 이 한 문장뿐이다.

**`merch_order`·`merch_order_item`**

| 역할(연결) | 코드 | 하는 일 |
| --- | --- | --- |
| `core_app` | `shop/adapters/db/drizzle-merch-orders.ts`(`DrizzleShopOrderStore`, `shop.module.ts` 171행) | 팬 주문 만들기·결제 시도·접수·취소·반품·환급·미수령 자동 취소·재고 예약 만료 |
| `core_app` | `shop/adapters/db/drizzle-merch-store.ts` 50행 `listSettlementItems`(`shop.module.ts` 170행, 내부 `GET /internal/v1/shop/product-settlement-items`) | 상품 정산 원천: 두 표를 결합해 읽는다 |
| `core_app` | 같은 파일 75행 `insertOrder` | 메모리·시험 조립용 넣기 |
| `core_partner` | **없음** | `DrizzleProductStore`(`shop.module.ts` 168행)만 파트너 연결을 쓰고 `product`·`product_stock`만 다룬다 |
| 소유자 | 마이그레이션, 시험 `admin` | — |

- `git log -S "merch-order-items" -- services/core-svc/src`로도 파트너 주문 서버 코드는 나오지 않는다. LCH-060(배송·반품 처리)은 화면 몫만 했다(`docs/progress-archive.md` 333행 '서버 저장… 막혔다').

#### 1.3 발송기가 붙는 역할

`main.ts` 165·178·249행: 발송기는 `PEAKET_DATABASE_URL`(`core_app`, 팬 경로와 같은 로그인)로 붙는다. 내부 입구도 `NOTIFY_APP_STORE`(`DATABASE`)다. DB가 발송기와 팬 경로를 가를 수 없으므로, 이 묶음은 '그 역할이 이 표에서 할 수 있는 일'을 발송기가 하는 일로 좁힌다. 발송기 전용 역할은 OPEN 문안(13)이다.

#### 1.4 파트너가 실제로 고쳐야 하는 칸

- 지금 코드: **없다**(1.2).
- 계약(openapi 6315~6560행)의 파트너 쓰기: 송장 등록(`READY → SHIPPED`, 송장), 송장 CSV 묶음, 반품 도착 확인(`RETURN_REQUESTED → RETURN_RECEIVED`), 반품 거절(→ `DISPUTED`, 사유), 현장 수령(`READY → PICKED_UP`). 서버가 생기면 쓸 칸 후보는 `status`·`tracking_no`·`shipped_at`·`picked_up_at`·`return_received_at`·`reject_reason`·`return_resolved_at`이고 모두 주문 항목 표다. 주문 표는 쓰지 않는다. 그래서 ADR-0338 결정 4가 그 묶음이 넘지 않을 선을 정한다.

#### 1.5 정산이 읽는 칸(`shop/domain/merch.ts` 117~172행)

| 쓰임 | `merch_order` | `merch_order_item` |
| --- | --- | --- |
| 금액 | `shipping_fee`(첫 항목에 한 번) | `unit_amount`·`quantity`(총액 = 단가 × 수량), `refunded_amount`, `commission_rate_bp` |
| 넣을지 | `status = 'PAID'`, `pg` 있음 | `status`(취소·환급·반품 요청·도착·분쟁은 뺌), `ticket_linked` |
| 기준일 | `pg_store`, `purchase_confirmed_at`(결제대금예치) | `event_ends_at`, `fulfillment`, `picked_up_at`, `delivered_at`, `shipped_at` |
| 귀속 | `id`, `promoter_id`, `event_id` | `id`, `order_id`, `promoter_id`, `event_id`, `product_id`, `product_name` |

- data.md는 단가 칸을 `unit_price`라 적지만 0016과 코드는 `unit_amount`다(14 목록, 이번에 그 줄에 적어 둠).

### 2. 위험 재현(마이그레이션과 코드로 세움, 실행은 7)

| # | 잘못된 쿼리(경로) | 지금 결과 | 0042 뒤 |
| --- | --- | --- | --- |
| R1 | 팬 경로: `update webhook_endpoint set url = 'https://attacker.example/hook'`(조건 빠짐) | 모든 파트너 끝점의 주소가 바뀌어 다음 주문 확정·지급 완료 사건이 그 주소로 서명돼 간다 | 칸 권한 거절(42501, PostgreSQL의 권한 거절 오류 코드)(①) |
| R2 | 팬 경로: `update webhook_endpoint set secret = 'whsec_…'` | 파트너가 모든 진짜 사건의 서명을 거절하고, DEAD가 쌓여 끝점이 `FAILING`으로 꺼진다 | 42501(①) |
| R3 | 팬 경로: `update webhook_endpoint set status = 'ACTIVE', disabled_reason = null` | 파트너가 일부러 끈 끝점이 다시 켜져 버린 주소로 사건이 간다 | 켜진 끝점만 고칠 수 있어 0행(②) |
| R4 | 팬 경로: `update webhook_endpoint set promoter_id = '<B>' where id = '<A 끝점>'` | B의 사건이 A의 주소로 간다 | 42501(①) |
| R5 | 파트너 A: `update merch_order_item set commission_rate_bp = 0`·`set unit_amount = unit_amount * 10`(조건 빠짐, 테넌트 A) | A의 모든 항목이 수수료 0·총액 10배로 상품 정산 원천에 오른다(`productSettlementItem`이 그 값을 그대로 싣는다) | 42501(⑤) |
| R6 | 파트너 A: `insert into merch_order (… status 'PAID', pg 'TOSS' …)`와 항목 넣기 | 결제가 없는 주문이 정산 항목이 된다 | 42501(⑤) |
| R7 | 파트너 A: `update merch_order_item set status = 'DELIVERED', delivered_at = now() - interval '30 days' where status = 'RETURN_REQUESTED'` | 반품 요청 항목이 정산에 들어가고 환급도 따로 나가 두 번 돈이 나간다 | 42501(⑤) |
| R8 | 파트너 A: `update merch_order set shipping_fee = 0`·`set status = 'PAID', pg = 'TOSS' where status = 'CREATED'` | 배송비·결제 여부가 바뀐 채 정산된다 | 42501(⑤) |

- 다른 파트너 행은 지금도 테넌트 정책이 막는다(R5~R8은 자기 테넌트 안의 돈 값이다). 팬 경로(R1~R4)는 테넌트를 넘는다.

### 3. 설계(정본: ADR-0338)

#### 3.1 0042가 하는 일

파일 `services/core-svc/migrations/0042_webhook_merch_write_grants.sql`. 문장마다 `--> statement-breakpoint`, 정책은 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`(다시 돌려도 같게, 0033·0040 꼴), 머리 주석에 까닭과 정본(ADR-0338, ADR-0241, authz-matrix §5.3). 차례를 바꾸지 않는다(표 단위 REVOKE는 같은 종류의 칸 권한도 거둔다).

1. 웹훅 끝점, 팬 경로 역할(ADR-0338 결정 1)
   - `REVOKE UPDATE ON "webhook_endpoint" FROM core_app` → `GRANT UPDATE ("status", "disabled_reason", "version") ON "webhook_endpoint" TO core_app`
   - `DROP POLICY IF EXISTS "webhook_endpoint_app_write"` → `CREATE POLICY "webhook_endpoint_app_disable" ON "webhook_endpoint" FOR UPDATE TO core_app USING ("status" = 'ACTIVE') WITH CHECK ("status" = 'DISABLED' AND "disabled_reason" = 'FAILING')`
   - `webhook_endpoint_app_read`와 `core_app`의 읽기는 **건드리지 않는다**(발송기 읽기 몫).
2. 웹훅 끝점, 파트너 역할(결정 2)
   - `REVOKE UPDATE ON "webhook_endpoint" FROM core_partner` → `GRANT UPDATE (아홉 칸) ON "webhook_endpoint" TO core_partner`(1.2 표의 아홉 칸)
   - 정책 `webhook_endpoint_partner_tenant`와 읽기·넣기는 그대로.
3. 굿즈 주문·주문 항목, 파트너 역할(결정 3)
   - `REVOKE INSERT, UPDATE ON "merch_order", "merch_order_item" FROM core_partner`(칸 권한을 다시 주지 않는다)
   - `DROP POLICY IF EXISTS "merch_order_partner_tenant"`·`"merch_order_item_partner_tenant"` → `CREATE POLICY "merch_order_partner_read" ON "merch_order" FOR SELECT TO core_partner USING (테넌트 식)`, `"merch_order_item_partner_read"`도 같은 꼴
   - `core_app` 권한과 `*_app_all`은 그대로.
4. FORCE·소유자는 바꾸지 않는다(결정 5).

- 쿼리·`schema.ts`·저장소는 바꾸지 않는다. 구현이 고치는 코드 파일은 주석 둘뿐이다(5).

#### 3.2 PostgreSQL 동작에서 시험·검증이 알아야 할 것(PostgreSQL 18 CREATE POLICY 문서 '명령별 적용 정책' 표, 2026-11-22 확인)

- UPDATE가 칸을 읽으면(WHERE·RETURNING·SET 식) 읽기 정책이 **고치기 전 행과 고친 뒤 행 모두**에 걸리고, 고친 뒤 행이 읽기 정책을 어기면 조용히 빠지지 않고 오류다. 발송기 끄기는 `WHERE id`와 `version + 1`을 읽으므로, `webhook_endpoint_app_read`를 켜진 끝점으로 좁히면 끄기가 오류로 실패한다(M8). 읽기 몫을 그대로 두는 까닭이다.
- 고치기 정책 USING은 고칠 행을 거르기만 한다(맞지 않는 행은 0행, 오류 없음). WITH CHECK에 걸리면 오류(42501)다. 그래서 ②의 '다시 켜기'는 0행이고, '사유만 바꾸기·판만 올리기'는 오류다.
- 고치기 정책이 하나도 없는 역할의 UPDATE는 권한이 있어도 0행이고 오류가 없다(기본 거부). ⑤는 0행이 아니라 42501을 단언해야 M11(권한만 남김)을 잡는다.
- **겹친 가드를 하나씩**: 웹훅 끝점의 팬 경로 고치기는 칸 권한과 정책이 겹친다. 칸 권한만 보려면(①) 허용된 끄기(`status = 'DISABLED', disabled_reason = 'FAILING'`)를 함께 SET해 정책이 통과하게 하고, 정책만 보려면(②) 허용된 세 칸만 SET한다. 굿즈 주문의 파트너 넣기도 권한과 '넣기 정책 없음'이 겹쳐, 넣기 권한만 남긴 틀린 구현(M17)은 행동으로 보이지 않고 ⑦의 칸 권한 단언만 잡는다.
- 파트너 판매자 칸 고치기는 칸 권한과 테넌트 WITH CHECK가 겹친다. ④는 값을 자기 테넌트로 골라 WITH CHECK가 지나게 해 칸 권한만 본다.
- 소유자·슈퍼유저는 정책을 건너뛴다. 시험 `admin`은 슈퍼유저라 시드·되돌리기를 그대로 한다. FORCE를 더해도 `admin`은 건너뛰어 ⑦만 잡는다(M18).
- 외래 키 검사는 행 보안을 건너뛴다. `id = id`처럼 값이 같은 고치기는 외래 키(`webhook_delivery.endpoint_id`)를 어기지 않는다.

#### 3.3 이전 판 코드(N-1)와 함께 돌기

코드를 바꾸지 않는다. 배포 창 동안 이전 판의 발송기 끄기 문장은 새 세 칸·새 정책 안이고, 파트너 웹훅 고치기의 SET 칸은 아홉 칸 안이다. 파트너 굿즈 주문 쓰기 코드는 이전 판에도 없다.

### 4. 다른 역할 영향(0042 뒤)

| 역할 | 영향 |
| --- | --- |
| `core_app` 발송기·내부 입구 | 켜진 끝점 찾기·다시 읽기·서명·발송 행 넣기 그대로. 끄기는 켜진 끝점에만 된다. 이미 꺼진(파트너가 끈) 끝점에 끄기를 부르면 0행이라 사유 `PARTNER`가 남는다(지금은 `FAILING`으로 덮는다. 경쟁 상황의 작은 행동 바뀜, ADR-0338 결정 1). `dispatcher.ts` 118행의 `disabled` 목록·알림 훅은 0행이어도 부른다(지금 알림 훅은 비어 있다. 정리 후보 14) |
| `core_app` 팬 굿즈·정산 원천 | 그대로(`*_app_all`, 권한 그대로) |
| `core_partner` 웹훅 | 등록·목록·고치기·재발급·발송 이력·다시 보내기 그대로(SET이 아홉 칸 안). 끝점 ID·판매자 칸만 고치지 못한다 |
| `core_partner` 굿즈 주문 | 자기 테넌트 읽기 그대로. 쓰기 코드가 없어 영향 없음 |
| `core_ops`·`core_maintenance`·`core_search`, 정의자 권한 함수 | 세 표의 권한·함수 참조가 없어 영향 없음 |
| 소유자·시드(`scripts/seed-demo.mjs`)·시험 `admin` | FORCE가 없어 그대로 |
| 다른 서비스 | payment-svc는 상품 정산 원천을 내부 HTTP로 읽는다(`core_app` 길). 영향 없음 |

- 시작 확인(`assertDatabaseRole`)은 그대로. 운영 확인 표(§8.4)는 해당 없음(새 기능·지표·절차 없음, 권한만 좁힌다).

### 5. 손댈 파일과 담당

| 담당 | 파일 | 할 일 |
| --- | --- | --- |
| 구현 | `services/core-svc/migrations/0042_webhook_merch_write_grants.sql`(새) | 3.1 |
| 구현 | `services/core-svc/migrations/meta/_journal.json` | `{"idx":42,"version":"7","when":<0040·0041·develop 마지막보다 큼>,"tag":"0042_webhook_merch_write_grants","breakpoints":true}`. 스냅숏 없음(0033·0034·0040과 같다) |
| 구현 | `src/modules/notify/adapters/db/drizzle-webhook-store.ts` 1~2행·251행 주석 | 발송기 연결은 `core_app`이고 이 표에서 켜진 끝점을 `FAILING`으로 끄는 세 칸만 고친다(ADR-0338 결정 1). 칸을 더 SET하거나 꺼진 끝점을 고치면 DB가 거절한다(주석만) |
| 구현 | `src/modules/shop/adapters/db/drizzle-merch-store.ts` 1행 주석 | 파트너 DB 역할은 두 표를 읽기만 한다(ADR-0338 결정 3·4)(주석만) |
| 시험 | `services/core-svc/test-int/webhook-merch-grants.int.test.ts`(새) | AZ-T18 ①~⑦ |
| 시험 | `services/core-svc/test-int/shop-notify.int.test.ts` 95~116행·257~284행 | 권한 기대값을 0042 뒤 모양으로(아래 6 끝) |
| 계획(이 커밋) | ADR-0338(새), authz-matrix §5.3·§7, data.md 세 줄, asvs/notify 8.4.1, asvs/settlement 8.2.3 | 정본 빈칸 먼저 |

- 구현 커밋은 시험 파일을, 시험 커밋은 시험 파일·이 계획 밖을 건드리지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: 적용된 마이그레이션(0004·0014~0016), 쿼리·`schema.ts`·`packages/platform`, `rls.int.test.ts`·`roles.ts`, 계약·생성물·화면, ADR-0241, `webhook_delivery`·`product`(14).

### 6. 시험 목록(시험 담당. 단언 값은 정본에서)

- **준비는 0042에 기대지 않는다**: 시드는 `admin`(슈퍼유저)으로 넣는다. 판매자 A·B, 공연장·공연·회차(A), 끝점 A1(A, 켜짐, 발송 행 없음)·A2(A, 꺼짐 `PARTNER`)·B1(B, 켜짐, 구독 `payout.completed`만이라 ③의 사건을 받지 않음), 발송기용 끝점 E(B, 켜짐, 구독 `order.confirmed`, 옛 비밀과 미래 기한)·F(B, 꺼짐 `PARTNER`), 굿즈 주문 OA1(A, `PAID`·`TOSS`·`STANDARD`·배송비 3,000)과 항목(배송 완료, 단가 15,000 × 2, 수수료 1,000bp, 기준일이 시험 기간 안), OA2(A, `CREATED`)와 항목, OB(B, `PAID`)와 항목.
- 연결: `loginFor`(`test-int/roles.ts`)로 `core_app` 사용자(연결 2)와 `core_partner` 사용자(**연결 하나짜리 풀**: 앞 트랜잭션이 쓴 연결을 다시 쓰는 경우가 저절로 생긴다, rls.int.test.ts 34행 꼴). ⑤의 정산 원천은 `shop-notify.int.test.ts`처럼 `AppModule.register({ database: appDb, partnerDatabase: <다른 파트너 풀>, media: testMedia() })`와 `PEAKET_INTERNAL_TOKEN`으로 띄운 서비스의 `GET /internal/v1/shop/product-settlement-items`를 부른다.
- 42501은 `rejects.toMatchObject({ cause: { code: '42501' } })`. 바꾼 상태는 `afterEach`에서 `admin`으로 되돌린다(구현 전 트리에서 고치기가 되므로 시험이 실패해도 되돌린다, W12-core-rls 시험 담당 꼴). 번호는 `AZ-T18 ①`처럼 ID 바로 뒤에.
- ③의 서명 기대값은 `node:crypto`의 HMAC으로 시험 안에서 따로 만든다(`domain/webhook.ts`의 `webhookSignature`로 만들지 않는다. `test/webhook-dispatcher.test.ts` 39행 시험 꼴). 시계는 가짜 시계, 수신기는 응답 차례를 정한 가짜(그 파일의 `Receiver` 꼴). 이 파일의 다른 발송 행은 DEAD·SUCCEEDED이거나 다음 시도 시각이 미래여서 ③ 말고는 집히지 않게 둔다.
- 시험이 기대는 공개 모양: 정책 이름(ADR-0338 결정 1·3), 칸 권한(결정 1·2·3), 일지 idx 42.

| 시험 이름 | 단언(정확한 값) | 구현 전 트리 |
| --- | --- | --- |
| `AZ-T18 ① 팬 경로 사용자는 허용된 끄기와 함께여도 웹훅 끝점의 주소·비밀·구독·판매자·끝점 ID 칸을 칸마다 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]` | `app`으로 A1에 `set <칸> = <새 값>, status = 'DISABLED', disabled_reason = 'FAILING' where id = A1`을 칸마다 따로: `url`(`https://attacker.example/hook`)·`secret`·`previous_secret`·`previous_secret_valid_until`·`event_types`·`secret_issued_at`·`promoter_id`(= B)·`id`(= `id`). 모두 42501. 끝에 `admin`으로 A1·A2·B1의 모든 칸이 시드 값 그대로 | 실패(고치기가 됨) |
| `AZ-T18 ② 팬 경로 사용자는 켜진 끝점을 FAILING으로 끄는 것 말고는 상태·사유·판을 바꾸지 못하고 꺼진 끝점을 다시 켜지 못한다 [ASVS v5.0.0-8.4.1]` | 가: `set status = 'ACTIVE', disabled_reason = null where id = A2` → 오류 없이 0행, A2는 `DISABLED`·`PARTNER`·판 그대로. 나: A1에 `set disabled_reason = 'PARTNER'` → 42501. 다: A1에 `set status = 'DISABLED', disabled_reason = 'PARTNER'` → 42501. 라: A1에 `set version = version + 1` → 42501. 끝에 A1 그대로 | 실패(가 1행, 나~라 됨) |
| `AZ-T18 ③ 발송기는 팬 경로 사용자로 켜진 끝점을 읽어 서명해 보내고 계속 실패하면 FAILING으로 끄며 이미 꺼진 끝점의 사유는 바꾸지 않는다 [ASVS v5.0.0-8.4.1]` | `admin`으로 E에 DEAD 49건(5일 [가정] 창 안, 성공 없음)을 넣는다. `new WebhookDispatcher({ store: new DrizzleWebhookStore(appDb), transport: <500만 주는 가짜>, clock })`로 `enqueue` 뒤 재시도 간격대로 `processDue` 일곱 번. 가짜 수신기가 받은 요청이 일곱이고 모두 E의 주소, `webhook-signature`가 지금 비밀·옛 비밀 두 서명(시험에서 따로 만든 값과 같음). 마지막에 그 발송 행 DEAD, E는 `DISABLED`·`FAILING`·판 2, 알림 훅 1번. 이어서 `store.disableEndpoint(F)`가 오류 없이 끝나고 F는 `DISABLED`·`PARTNER`·판 1 그대로, `store.findEndpointById(F)`는 F를 돌려준다 | 실패(F가 `FAILING`·판 2로 바뀜). 나머지는 통과 → M6~M8 |
| `AZ-T18 ④ 파트너 트랜잭션은 자기 테넌트 끝점만 읽고 고치며 자기 끝점이라도 판매자·끝점 ID 칸은 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]` | 테넌트 A: 조건 없는 읽기의 ID가 정렬해 정확히 `[A1, A2]`(비밀 칸도 읽힘). WHERE·RETURNING 없는 `set url = 'https://a2.example.com/hook'` 뒤 `admin`으로 A1·A2만 바뀌고 B1·E·F는 그대로. A 트랜잭션을 돈 뒤 테넌트 없는 트랜잭션 읽기 `[]`·고치기 오류 없이 0행, 트랜잭션 밖 읽기 `[]`. A1에 `set promoter_id = A`·`set id = id` 각각 42501. A1에 아홉 칸을 모두 새 값으로(`version = version + 1`) `where id = A1 returning id` → `[{ id: A1 }]`. `promoter_id = B` 넣기 42501 | 실패(판매자·끝점 ID 고치기가 됨). 나머지는 통과 → M9·M10 |
| `AZ-T18 ⑤ 파트너 트랜잭션은 자기 테넌트의 굿즈 주문·주문 항목을 넣거나 칸마다 고치거나 지우지 못하고 상품 정산 원천 응답이 그대로다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]` | 먼저 정산 원천 응답을 받아 둔다(OA1 항목: 총액 33,000·수수료 1,000bp). 테넌트 A로 WHERE·RETURNING 없는 고치기를 칸마다 따로: 항목 `unit_amount`(15,001)·`quantity`(3)·`commission_rate_bp`(0)·`refunded_amount`·`status`(`CANCELLED`)·`shipped_at`·`delivered_at`·`tracking_no`, 주문 `status`(`PAID`)·`shipping_fee`(0)·`pg`·`purchase_confirmed_at`·`amount`. 모두 42501(0행이 아니라 오류). `PAID` 주문·그 항목 넣기 각각 42501, 두 표 지우기 각각 42501. 끝에 정산 원천 응답이 처음과 깊이 같고, `admin`으로 두 표의 모든 행이 시드 값 그대로 | 실패(고치기·넣기가 되고 응답이 바뀜) |
| `AZ-T18 ⑥ 파트너 트랜잭션의 굿즈 주문·주문 항목 읽기는 자기 테넌트 행뿐이고 테넌트 없이는 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]` | 테넌트 A의 조건 없는 읽기 ID가 두 표 모두 정확히 A의 행(OA1·OA2와 그 항목), B는 OB와 그 항목. A 트랜잭션 뒤 테넌트 없는 트랜잭션 `[]`(22P02 없이), 트랜잭션 밖 `[]` | 통과(있던 동작) → M14~M16 |
| `AZ-T18 ⑦ 세 표의 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책과 칸 권한이 정한 모양이다 [ASVS v5.0.0-8.4.1]` | `pg_class` 세 표 `relrowsecurity` 참·`relforcerowsecurity` 거짓, 소유자가 세 앱 역할·로그인 사용자 아님. `pg_policies`(`roles::text[]`)를 표·이름 차례로 정확히: `webhook_endpoint` = `webhook_endpoint_app_disable`(UPDATE, `{core_app}`, `qual`·`with_check`가 결정 1의 식), `webhook_endpoint_app_read`(SELECT, `{core_app}`, `true`, 없음), `webhook_endpoint_partner_tenant`(ALL, `{core_partner}`, 0015의 테넌트 식 그대로); `merch_order` = `merch_order_app_all`(ALL, `{core_app}`, `true`, `true`), `merch_order_partner_read`(SELECT, `{core_partner}`, `qual`이 `production_partner_tenant`의 `qual` 글과 같음, 없음); `merch_order_item`도 같은 꼴. `has_table_privilege`·`has_column_privilege`로 `core_app`의 끝점 UPDATE는 표 단위 거짓·칸은 셋만 참, `core_partner`의 끝점 UPDATE는 표 단위 거짓·칸은 아홉만 참, `core_partner`의 두 주문 표 INSERT·UPDATE는 표 단위·모든 칸 거짓이고 SELECT는 참 | 실패(옛 정책·표 단위 권한) |

- **기존 시험 고침(같은 시험 커밋)**: `shop-notify.int.test.ts` 95행 시험의 `core_partner` 기대값 `webhook_endpoint`를 `INSERT,SELECT`로, 257행 시험의 `merch_order`·`merch_order_item`을 `SELECT`로, `core_app` `webhook_endpoint`를 `SELECT`로 바꾸고 '표 단위 권한만 본다. 칸 권한은 AZ-T18 ⑦'이라는 주석 한 줄. 시험 이름·다른 단언은 그대로. 구현 전 트리에서는 이 두 시험도 실패한다.
- 회귀(게이트에서 돈다): `shop-notify.int`(파트너 웹훅 HTTP 등록·고치기·재발급·이력·다시 보내기, 내부 입구, 정산 원천), `webhook-lease.int`·`webhook-lease-concurrent.int`, `shop-order.int`·`shop-cancel.int`·`shop-return.int`·`shop-expiry.int`·`shop-unclaimed.int`·`shop-refund-account.int`(팬 경로 쓰기), `shop-migration.int`, `rls.int`(W12-core-rls), W12-core-idem 새 파일 셋, `test/webhook-dispatcher.test.ts`, `test/migrations-journal.test.ts`, `test/shop-notify.migration.test.ts`.

### 7. 실패 확인(시험 담당)

- **어디서**: 두 앞 묶음이 develop에 든 뒤 rebase하고, 시험 커밋을 이 계획 커밋 위에 쌓은 트리(0042 없음).
- **길 (가) 로컬 Docker**(감독이 갈래 2 차례를 줄 때만): `docker info` → `bash D:/ticketpass-locks/lock.sh take docker lane2-W12-core-rls2`(남이 쥐었으면 `who`를 적고 기다리지 말고 길 (나)) → `pnpm exec turbo run build --filter=@peaket/core-svc^...` → `pnpm --filter @peaket/core-svc test:integration test-int/webhook-merch-grants.int.test.ts test-int/shop-notify.int.test.ts` → 자기 컨테이너만 `docker rm -f -v` → `lock.sh drop docker lane2-W12-core-rls2`.
- **길 (나) 초안 PR CI**(기본): 시험 커밋을 올리고(rebase 뒤라 `feature/lane2-W12-core-rls2-r2`) `gh pr create --draft --base develop --head <가지>`로 초안 PR을 연다. `ci.yml` → `ci-node.yml`의 `node` 잡이 core-svc 통합 시험 전부를 돈다(92행). `gh run view <실행 ID> --log-failed`로 그 잡의 실패 시험과 실제 값을 읽는다. 다른 통합 시험이 실패하면 이 묶음과 관계없는 것인지 적는다.
- **기대**: ①②③④⑤⑦과 고친 `shop-notify` 두 시험이 **단언 실패**(실행조차 안 되는 실패가 아니다). ⑥은 통과(있던 동작)이고 M14~M16으로, ③의 발송 몫과 ④의 아홉 칸은 M6~M8·M10으로 본다(§8.6 7 '구현 전 트리에서 실패를 볼 수 없는 시험').
- **적을 것**: 길, 명령(또는 실행 ID), 파일마다 통과·실패 수, 실패마다 실제 값 한 줄, 처음부터 통과한 시험과 그 실패를 볼 표본 번호, 잠금 시각(길 가).

### 8. 틀린 구현 표본(검증 담당, 18개, 항목마다 1개 이상)

기준선은 구현 뒤 트리에서 새 파일과 `shop-notify.int` 통과. 표본마다 하나만 넣고 돌린 뒤 `git checkout -- <파일>`. 0042를 바꾸는 표본은 통합 시험이 파일마다 새 컨테이너에 마이그레이션을 다시 올리므로 그대로 걸린다. 무거우면 표본을 몇 개씩 묶은 초안 PR CI로 돌려도 된다(표본마다 실행 하나).

| # | 항목 | 넣을 곳 | 틀린 구현 | 잡아야 할 시험 |
| --- | --- | --- | --- | --- |
| M1 | ① | 0042 | `core_app`의 `REVOKE UPDATE` 줄을 뺀다(표 단위 고치기가 남고 정책만 좁다) | ①⑦ |
| M2 | ① | 0042 | `core_app` 칸 권한에 `url`을 더한다 | ①(url)⑦ |
| M3 | ② | 0042 | `webhook_endpoint_app_disable` USING을 `true`로 | ②가(오류), ③(F가 `FAILING`), ⑦ |
| M4 | ② | 0042 | WITH CHECK에서 사유 조건을 빼 `status = 'DISABLED'`만 | ②다, ⑦ |
| M5 | ② | 0042 | 옛 `webhook_endpoint_app_write`를 지우지 않는다(조건 없는 정책이 OR로 남음) | ②가~라, ⑦ |
| M6 | ③ | 0042 | 옛 정책만 지우고 `webhook_endpoint_app_disable`을 만들지 않는다 | ③(끄기가 0행이라 E가 켜진 채), ⑦ |
| M7 | ③ | 0042 | `core_app` 칸 권한에서 `version`을 뺀다 | ③(끄기 42501), ⑦ |
| M8 | ③ | 0042 | `webhook_endpoint_app_read`를 `status = 'ACTIVE'`로 좁힌다 | ③(끄기가 고친 행 읽기 검사로 오류, F 읽기 없음), ⑦ |
| M9 | ④ | 0042 | `core_partner`의 `REVOKE UPDATE` 줄을 뺀다 | ④(판매자·끝점 ID), ⑦ |
| M10 | ④ | 0042 | 파트너 칸 권한에서 `previous_secret_valid_until`을 뺀다 | ④(아홉 칸), `shop-notify` 비밀 재발급, ⑦ |
| M11 | ⑤ | 0042 | `merch_order_item`의 `REVOKE`에서 `UPDATE`를 뺀다(읽기 정책은 나눈 그대로) | ⑤(42501이 아니라 0행), ⑦ |
| M12 | ⑤ | 0042 | `merch_order`의 `REVOKE`를 빼고 `merch_order_partner_tenant`도 지우지 않는다 | ⑤(주문 고치기·넣기가 되고 정산 응답이 바뀜), ⑦ |
| M13 | ⑤ | 0042 | 앞으로 쓸 칸을 미리 준다: `GRANT UPDATE ("status", "tracking_no", "shipped_at") ON "merch_order_item" TO core_partner`와 FOR UPDATE 테넌트 정책 | ⑤(상태·출고 시각 고치기가 되고 정산 응답이 바뀜), ⑦ |
| M14 | ⑥ | 0042 | `merch_order_partner_read`를 만들지 않는다 | ⑥(A가 `[]`), ⑦ |
| M15 | ⑥ | 0042 | `merch_order_item_partner_read` 식에서 `nullif`를 뺀다 | ⑥(연결 재사용에서 22P02) |
| M16 | ⑥ | 0042 | `merch_order_partner_read`를 `promoter_id = coalesce(nullif(…)::uuid, promoter_id)`로 | ⑥(테넌트 없이 모두), ⑦ |
| M17 | ⑦ | 0042 | `merch_order`의 `REVOKE`에서 `INSERT`를 뺀다(넣기 정책이 없어 행동은 같다) | ⑦만 |
| M18 | ⑦ | 0042 | `ALTER TABLE "webhook_endpoint" FORCE ROW LEVEL SECURITY`를 더한다 | ⑦만(`admin`은 슈퍼유저라 FORCE도 건너뜀) |

- 항목마다 수: ① 2, ② 3, ③ 3, ④ 2, ⑤ 3, ⑥ 3, ⑦ 2. 정책 식 칸 이름을 틀리면 0042가 42703으로 멈춰 모든 통합 시험이 멈추므로 세지 않는다. 장애 주입은 해당 없음(복구 경로가 없는 권한 변경).
- '검증' 절에 적을 것: 표본마다 실패한 시험, 놓친 표본과 시험 담당에게 넘긴 것, AZ-T18 ①~⑦ 판정 기준과 단언의 대조 전수.

### 9. 게이트 명령과 닿는 CI 잡

```bash
cd /d/ticketpass-lane2-b176   # rebase 뒤 새 가지를 쓰면 그 작업 폴더
pnpm exec turbo run build --filter=@peaket/core-svc^...
pnpm --filter @peaket/core-svc typecheck
pnpm --filter @peaket/core-svc test                     # 단위 전부(0042 when 포함)
# 합치기 직전 develop 위로 다시 쌓은 트리에서. Docker 차례가 없으면 초안 PR CI(ADR-0283 결정 3)
PEAKET_TEST_REPORT=test-report-int.json pnpm --filter @peaket/core-svc test:integration   # 통합 전부
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/trace-check.mjs --ids "AZ-T18, v5.0.0-8.2.3, v5.0.0-8.4.1" --report services/core-svc/test-report-int.json
node tools/ci/roles-check.mjs --base origin/develop --head <합칠 가지>   # 감독이 합치기 직전
```

| 잡 | 왜 |
| --- | --- |
| `ci.yml` → `ci-node.yml` / node | core-svc typecheck·단위·통합 시험 |
| `docs-check` | ADR-0338·authz-matrix·data.md·ASVS 두 표·이 계획 |
| `lint-guard` | 주석만 바꾸지만 core-svc 파일이 닿는다 |

- spec-check: `specs/specs.json`이 바꾸는 문서를 가리키지 않아 해당 없음.
- 장부: BUILD_ORDER 묶음이 아니라 `ledger.mjs --batch`는 쓰지 않는다. 지금 `node tools/ci/ledger.mjs --scope AZ-T18`은 항목 7·빈칸 7·등급 B다. 감독 결정으로 A로 증명한다. 기록 담당이 `node tools/ci/ledger.mjs`로 다시 쓰고 AZ-T18 ①~⑦이 '자동 시험'인지 본다.
- `pnpm`이 막히면 `npx tsc -p services/core-svc/tsconfig.json --noEmit`, `npx vitest run --config vitest.integration.config.mjs <파일>`(core-svc 폴더).
- 리뷰(보안): 정책 식과 칸 목록(1.2 표·ADR-0338), REVOKE·GRANT 차례, 다른 역할 경로(4 표), 발송기 몫이 끄기 하나로 좁혀졌는지와 읽기 몫을 좁히지 않았는지(3.2), FORCE·소유자, N-1(3.3), 시험이 쿼리 조건 없이 DB 가드만 보고 겹친 가드를 하나씩 보는지.

### 10. 자주 놓친 결함 가운데 해당하는 것

- 정확한 값까지: ①④⑥ 보이는·바뀐 행 목록 전체, ③ 보낸 요청 수·주소·서명 값·끈 끝점의 사유와 판, ⑤ 정산 원천 응답 전체와 모든 행 값.
- 경계·세 상태: 테넌트 있음(④⑥)·없음·빈 문자열(연결 재사용, ④⑥). 실패 기준 49건 + 1(③, 값은 notify.md §9 [가정]).
- 겹친 가드 하나씩: 칸 권한과 정책(①은 허용 끄기와 함께, ②는 허용 칸만, 3.2), 판매자 칸 권한과 WITH CHECK(④는 자기 테넌트 값), 넣기 권한과 넣기 정책 없음(M17은 ⑦).
- 목록 밖 값마다: ① 칸마다, ② 상태·사유·판 경우마다, ⑤ 정산 칸마다.
- 부르는 쪽이 결과를 쓰는지: ③은 실제 발송기를 `core_app`으로 돌려 수신기가 받은 요청을 보고, ⑤는 정산 원천 HTTP 응답을 견준다. 시험 값은 상수와 다르게(단가 15,001, 수량 3).

### 11. 범위 밖

발송기 전용 DB 역할(13 OPEN), `webhook_delivery`·`product`와 아래 14의 표, 파트너 배송·반품 처리 서버(ADR-0338 결정 4의 선만 정함), 파트너의 주문 읽기 칸 좁히기, `disableEndpoint`가 0행일 때의 보고, 계약·화면.

### 12. WBS 일 [가정]

1.3일 = 계획 0.2 + 시험 0.4(새 통합 파일 하나, HTTP 조립 하나, 기존 단언 둘) + 구현 0.15(마이그레이션·주석) + 리뷰 0.15 + 검증 0.3(표본 18개) + 기록 0.1. 감독이 coord.md에 적는다.

### 13. OPEN 문안 후보(감독 결정 대기)

> **OPEN[다음 번호]** core-svc 웹훅 발송기 전용 DB 역할(W12-core-rls2가 남김, ADR-0338 '결과'의 남는 한계). 발송기가 팬 경로 역할 `core_app`으로 붙어, 그 역할은 0042 뒤에도 모든 파트너 웹훅 비밀을 읽고 켜진 끝점을 `FAILING`으로 끌 수 있다. 발송 원장 `webhook_delivery`는 `core_app`에 조건 없는 `FOR ALL` 정책(0016)이라, 팬 경로 쿼리 하나로 아무 끝점에 꾸민 본문의 발송 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다(가짜 주문 확정·지급 완료). notify.md §13은 '발송 워커의 서비스 계정만 비밀을 읽는다'고 적는다.
> (가) 추천: 그룹 역할 `core_notify`와 연결 `PEAKET_NOTIFY_DATABASE_URL`을 새로 두고 발송기·내부 입구만 그 연결로 붙인다. `webhook_endpoint` 읽기·끄기 몫과 `webhook_delivery` 쓰기를 그 역할로 옮기고 `core_app`의 두 표 권한·정책을 거둔다. 시작 확인(ADR-0241 결정 7)에 더하고 로컬·CI·배포 값에 주소를 더한다. 배포 창 동안 이전 판이 `core_app`으로 쓰므로 두 번에 나눠 낸다(먼저 새 역할 권한과 연결, 다음 배포에서 `core_app` 권한 거두기). 새 묶음(A, 보안 높음).
> (나) 그대로 두고 남는 위험으로 적는다(주소·비밀 바꾸기는 0042가 막는다).

### 14. 새로 찾은 표 목록(고치지 않음, ADR-0283 결정 6)

| 표·칸 | 누가 무엇을 | 위험 한 줄 |
| --- | --- | --- |
| `webhook_delivery` | `core_app` `INSERT, UPDATE`(0016 77행)·`webhook_delivery_app_all` FOR ALL `true`(0016 105행) | 팬 경로 쿼리 하나로 아무 끝점에 꾸민 본문을 넣으면 발송기가 파트너 비밀로 서명해 보낸다. 상태를 고쳐 진짜 사건을 DEAD로 만들거나 끝난 행을 다시 보낼 수도 있다. **높음 후보**(13 OPEN이 함께 닫는다) |
| `product.commission_rate_bp` | `core_partner` `SELECT, INSERT, UPDATE` 표 단위(0014 46행). 코드가 계약 값을 넣지만(`products.ts` 113·155행) DB는 아무 값이나 받는다 | 파트너 경로 쿼리 하나로 자기 상품 수수료율을 0으로 바꾸면 그 뒤 주문 항목이 그 값을 복사해 정산된다(이 묶음이 지키는 값의 한 단계 앞). **높음 후보(돈)**. 방향 후보: 파트너의 상품 고치기를 칸 단위로 좁히고 수수료율은 게시 때 정의자 권한 함수나 트리거가 계약 표에서 채운다 |
| `merch_order` 개인정보 칸 | `core_partner` 표 단위 읽기(0016 71행, 0042 뒤에도) | 자기 테넌트 주문의 받는 분 이름·연락처·주소·구매 계정·결제 ID 원문을 DB에서 읽는다. 계약은 가린 값과 접속기록이 남는 보기만 준다. 중간 |
| `attendee_export` | `core_partner` `SELECT, INSERT, UPDATE` 표 단위(0016 73행), 코드는 넣기만(`drizzle-export-store.ts` 31행) | 파트너 경로 쿼리 하나로 자기 테넌트 내려받기 이력의 건수·결과를 고친다(접속기록 무결성). 낮음~중간 |
| `core_app` 기본 읽기 권한 | 0004 25행 `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES TO core_app` | 뒤에 만드는 모든 표를 팬 경로 역할이 읽는다(웹훅 비밀이 그렇게 열렸다). 새 표마다 거둘 것을 잊기 쉽다. 낮음~중간(구조) |
| data.md `merch_order_item` | 문서가 `unit_price`라 적고 칸 일부(`promoter_id`·`event_id`·`product_name`·`fulfillment`·`ticket_linked`·`shipped_at`·`refunded_amount`·`event_ends_at` 등)가 빠져 있다 | 정본과 0016·코드가 어긋난다. 이번에는 `unit_price` 줄에 실제 이름만 적었다. 낮음(문서) |
| 파트너 굿즈 주문 계약 경로 | `gw-partner` 라우트가 `/v1/partner/merch-order-items` 등을 core-svc로 보내지만 서버 처리기가 없다 | 화면이 실제 서버에서 404를 받는다. 서버를 만들 때 ADR-0338 결정 4를 따른다. 낮음(기능 빈칸) |
| `dispatcher.ts` 118행 | 끄기가 0행이어도 `disabled`에 넣고 알림 훅을 부른다 | 0042 뒤 경쟁 상황에서 꺼지지 않은 끝점을 껐다고 보고할 수 있다(지금 알림 훅은 비어 있다). 낮음 |

## 실패 확인

(시험 담당이 위 7대로 쓴다.)

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
| plan | lane2-w12corerls2-plan | claude-opus-5-5 | 2026-11-22T02:26+09:00 | 2026-11-22T02:58+09:00 |

## 기록

(기록 담당이 쓴다.)

- **다음 단계**: W12-core-rls·W12-core-idem이 develop에 합쳐진 뒤 이 가지를 rebase해 `feature/lane2-W12-core-rls2-r2`로 올리고, 시험 담당(`lane2-w12corerls2-test`)이 위 6의 시험을 쓰고 위 7대로 구현 전 트리에서 실패를 본다.
