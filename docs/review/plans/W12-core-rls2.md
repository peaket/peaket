# 작업 계획: W12-core-rls2(웹훅 끝점·굿즈 주문·상품 수수료율의 앱 역할 쓰기 권한 좁히기)

- **무엇**: core-svc 세 군데의 DB 쓰기 권한이 너무 넓다. (1) 웹훅 끝점 표 `webhook_endpoint`(파트너가 사건을 받을 주소와 서명 비밀을 적은 표)는 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)이 있지만, 0016이 팬 경로 역할 `core_app`에 표 단위 고치기와 조건 없는 정책을 줬다. 팬 경로 쿼리 하나로 모든 파트너의 웹훅 주소·비밀을 바꿀 수 있다. (2) 굿즈 주문 표 `merch_order`·`merch_order_item`은 0016이 파트너 역할 `core_partner`에 표 단위 넣기·고치기를 줬다. 자기 테넌트(파트너사 하나의 데이터 범위) 주문의 단가·수수료율·상태를 고치거나 결제 안 된 주문을 넣을 수 있고, 상품 정산 원천이 그 값을 그대로 읽는다(돈). (3) 상품 표 `product`는 0014가 파트너 역할에 표 단위 고치기를 줘, 주문 항목이 복사하는 상품 수수료율을 파트너 경로 쿼리 하나로 아무 값으로 바꿀 수 있다(돈). 감독 결정(2026-11-22, W12-core-idem 계획의 '다른 표 목록'에서 나온 높음 둘. 같은 날 둘째 결정으로 (3)을 더하고 발송 원장·발송기 전용 역할은 W12-core-notify로 뗌): 등급 A처럼 한다(시험 먼저, 틀린 구현은 판정 항목마다, 리뷰는 보안 관점). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-lane2-b176`, 가지 `feature/lane2-W12-core-rls2`, 출발점 `origin/develop` `e43bc2633`(계획을 쓰는 동안 `456df0929`에서 앞으로 감았다. core-svc 마이그레이션 마지막은 그대로 `0034_sale_review_request`, journal `when` 1795118255889). 2026-11-22 계획 담당(세션 `lane2-w12corerls2-plan`)이 썼고 제품·시험 코드는 쓰지 않았다. 마이그레이션 **0042**·ADR **0338**은 감독이 나눈 번호다.
- **앞 묶음**: W12-core-rls(가지 `origin/feature/lane2-W12-core-rls`, 0040 `promoter` 행 보안, ADR-0327에 그 가지가 더하는 결정 13)와 W12-core-idem(가지 `origin/feature/lane2-W12-core-idem`, 0041 `idempotency_record`, 그 가지에만 있는 새 ADR 0337번). 두 계획과 0040은 `git show`로 읽었다. 이 묶음은 둘이 develop에 합쳐진 뒤 rebase해 시험·구현한다. 정책 꼴(명령마다 나눈 정책, `app.tenant_id`와 `nullif`, 칸 단위 GRANT, `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`, FORCE 없음)은 두 묶음과 같다.
- **차례**: 시험 먼저. 계획 → 시험(구현 전 트리에서 실패 확인) → 구현 → 리뷰(보안) → 리뷰 반영 → 검증(틀린 구현 24개) → 기록. 계획 커밋에 `Batch-Order`를 달지 않는다(docs/architecture.md §8.6 '차례').
- **정본**: [ADR-0338](../../adr/0338-core-webhook-endpoint-merch-order-write-grants.md)(새로 씀), [ADR-0241](../../adr/0241-core-svc-partner-row-security.md) 결정 1·3·4·5·6·7, [ADR-0320](../../adr/0320-promoter-contract-terms-approval-and-freeze.md) 결정 6, [devops.md](../../devops.md) §7.1, [authz-matrix](../../security/authz-matrix.md) §3.3·§5.3(새 줄)·§7 **AZ-T18**(새 시험 ID), [data.md](../../data.md) `webhook_endpoint.disabled_reason`·`product.commission_rate_bp`·`merch_order_item.unit_price`·`commission_rate_bp`, [asvs/notify](../../security/asvs/notify.md) 8.4.1, [asvs/settlement](../../security/asvs/settlement.md) 8.2.3, [notify.md](../../features/notify.md) §9·§13, [settlement.md](../../features/settlement.md) §4.5, ADR-0300 결정 9.

## 감독에게

1. **로컬 재현은 하지 않았다.** 지시대로 Docker를 쓰지 않았다(갈래 1·4 차례). 잠금·컨테이너는 건드리지 않았다. 위험은 마이그레이션 원문과 코드 경로로 세웠다(아래 2). 시험 담당의 실패 확인(7)이 첫 실행이고, Docker 차례가 오지 않으면 초안 PR CI로 본다.
2. **겹치는 파일**(두 앞 묶음이 먼저 합쳐지고 이 가지가 rebase한다):
   - `services/core-svc/migrations/meta/_journal.json`: W12-core-rls idx 40(`when` 1795281728010), W12-core-idem idx 41, 이쪽 idx 42. 0042의 `when`은 0040·0041과 구현 직전 develop 마지막 `when`보다 커야 한다(`test/migrations-journal.test.ts`). 0035~0039(갈래 3·5 몫)가 뒤에 합쳐지면 그쪽이 다시 매긴다.
   - `test-int/rls.int.test.ts`(W12-core-rls가 고침): **고치지 않는다.** 새 시험은 새 파일 하나에 둔다(아래 6).
   - `docs/security/authz-matrix.md` §7: W12-core-idem의 AZ-T17 줄과 이쪽 AZ-T18 줄이 develop의 AZ-T16 줄 바로 뒤 같은 자리에 들어가 rebase 때 충돌이 난다. 두 줄을 다 남기고 AZ-T17 → AZ-T18 차례로 둔다. §5.3은 W12-core-rls가 'core-svc 구현' 줄을, W12-core-idem이 'ops-svc 구현' 줄 뒤에 새 줄을 더하고, 이쪽은 '비용과 확인' 줄 뒤에 더해 붙지 않는다.
   - `docs/data.md`(앞 묶음은 `promoter.id`·멱등 기록 표 문단, 이쪽은 1744·1745·1810행), `docs/security/asvs/settlement.md`(W12-core-rls는 8.4.1, 이쪽은 8.2.3): 붙지 않은 줄이라 충돌이 없을 것이다. ADR-0241은 이쪽이 고치지 않는다.
   - 자기 작업 가지의 강제 푸시(`--force-with-lease`)가 세션 권한 판정에 막히므로(docs/lanes/lane5-cleanup.md 21행) rebase한 가지는 `feature/lane2-W12-core-rls2-r2`로 새로 올리고, 초안 PR도 그 가지로 다시 연다.
3. **판단 셋(방향 안, 확인 바람)**:
   - 파트너의 굿즈 주문 '필요한 칸'은 **0개**다. 파트너 코드가 두 표를 쓰는 곳이 없다(배송·반품 처리 서버가 아직 없다, 1.4). 그래서 칸 고치기를 하나도 남기지 않고, 계약의 전이가 쓸 칸과 끝까지 주지 않을 칸의 선을 ADR-0338 결정 5에 적었다.
   - 지시는 '표 단위 UPDATE를 거둔다'였지만 같은 GRANT 줄(0016 71행)의 **INSERT도 거둔다**. 결제 끝남(`PAID`) 주문을 넣으면 정산에 그대로 오르므로 고치기와 같은 돈 위험이다(2의 R6).
   - **상품 수수료율은 칸 권한이 아니라 트리거가 지킨다.** 파트너 코드가 상품을 넣고 고칠 때 수수료율 칸을 함께 적고(계약에서 읽은 값), 넣기는 Drizzle이 모든 칸을 적어 칸 단위로 좁힐 수 없다. 그래서 0042의 트리거 `product_commission_from_contract`가 파트너 역할이 넣거나 고친 행의 수수료율을 '게시 때 계약 값, 그 뒤 그대로'로 덮어쓴다(ADR-0338 결정 4). 고치기 칸은 상품 ID·판매자를 뺀 스물을 주는데, **수수료율 칸 권한은 이번에는 남긴다**. 이전 판 코드가 그 칸을 SET해서 같이 거두면 배포 창 동안 파트너 상품 고치기가 모두 거절되기 때문이다(devops.md §7.1 '스키마 변경과 그 변경에 기대는 코드 변경은 같은 배포에 넣지 않는다'). 이 묶음 코드는 SET에서 그 칸을 빼고, 그 코드가 배포된 뒤 첫 core-svc 마이그레이션이 그 칸 권한을 거둔다(아래 13.2). 그동안에도 쓰이는 값은 트리거가 정한다. 칸 권한까지 이번에 거두려면 devops.md §7.1의 예외 결정이 필요하다.
4. **새 ADR-0338**(결정 1~8): 발송기 몫(읽기 그대로, 고치기는 켜진 끝점을 `FAILING`으로 끄는 세 칸만, 이미 꺼진 끝점에는 0행이 되는 행동 바뀜), 파트너 웹훅 칸 아홉, 파트너 굿즈 주문 읽기만, 상품 수수료율(트리거·칸 스물·두 번에 나눔), 파트너 쓰기 경로를 만들 때의 선, FORCE 없음, 이전 판 호환, 0042. 0338 말고 번호는 쓰지 않았다.
5. **새 시험 ID AZ-T18**(authz-matrix §7, ①~⑧. ⑧이 상품 수수료율). 첫 계획 커밋 직전 develop과 원격 가지 전부에 AZ-T18이 없음을 봤다(AZ-T17은 W12-core-idem 몫). `node tools/ci/ledger.mjs --scope AZ-T18`은 항목 8·빈칸 8·등급 B다.
6. **넘기는 것**(13): 발송 원장 `webhook_delivery`와 발송기 전용 DB 역할 `core_notify`는 새 묶음 **W12-core-notify**(갈래 3)로 뗀다(조사 내용을 13.1에 남김, 묶음 줄은 기록 커밋에서 감독이 더함). 상품 수수료율 칸 권한 축소는 13.2다.
7. **정리 목록 후보 여섯**(14, 중간·낮음, 고치지 않음). '파트너 굿즈 주문 계약 경로에 서버 처리기 없음'은 갈래 5 몫이다.
8. **WBS 일 [가정] 1.8일**(12).

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

`main.ts` 165·178·249행: 발송기는 `PEAKET_DATABASE_URL`(`core_app`, 팬 경로와 같은 로그인)로 붙는다. 내부 입구도 `NOTIFY_APP_STORE`(`DATABASE`)다. DB가 발송기와 팬 경로를 가를 수 없으므로, 이 묶음은 '그 역할이 이 표에서 할 수 있는 일'을 발송기가 하는 일로 좁힌다. 발송기 전용 역할은 새 묶음 W12-core-notify로 뗐다(13.1).

#### 1.4 파트너가 실제로 고쳐야 하는 칸

- 지금 코드: **없다**(1.2).
- 계약(openapi 6315~6560행)의 파트너 쓰기: 송장 등록(`READY → SHIPPED`, 송장), 송장 CSV 묶음, 반품 도착 확인(`RETURN_REQUESTED → RETURN_RECEIVED`), 반품 거절(→ `DISPUTED`, 사유), 현장 수령(`READY → PICKED_UP`). 서버가 생기면 쓸 칸 후보는 `status`·`tracking_no`·`shipped_at`·`picked_up_at`·`return_received_at`·`reject_reason`·`return_resolved_at`이고 모두 주문 항목 표다. 주문 표는 쓰지 않는다. 그래서 ADR-0338 결정 5가 그 묶음이 넘지 않을 선을 정한다.

#### 1.5 정산이 읽는 칸(`shop/domain/merch.ts` 117~172행)

| 쓰임 | `merch_order` | `merch_order_item` |
| --- | --- | --- |
| 금액 | `shipping_fee`(첫 항목에 한 번) | `unit_amount`·`quantity`(총액 = 단가 × 수량), `refunded_amount`, `commission_rate_bp` |
| 넣을지 | `status = 'PAID'`, `pg` 있음 | `status`(취소·환급·반품 요청·도착·분쟁은 뺌), `ticket_linked` |
| 기준일 | `pg_store`, `purchase_confirmed_at`(결제대금예치) | `event_ends_at`, `fulfillment`, `picked_up_at`, `delivered_at`, `shipped_at` |
| 귀속 | `id`, `promoter_id`, `event_id` | `id`, `order_id`, `promoter_id`, `event_id`, `product_id`, `product_name` |

- data.md는 단가 칸을 `unit_price`라 적지만 0016과 코드는 `unit_amount`다(14 정리 후보, 이번에 그 줄에 적어 둠).

#### 1.6 상품 `product`의 수수료율(감독 결정 둘째로 더함)

- 권한·정책: `core_partner` `SELECT, INSERT, UPDATE` 표 단위(0014 46행), `product_partner_tenant` FOR ALL 테넌트 식(0014 54행). `core_app`은 읽기(기본 권한)와 `product_app_read`(0014 62행). 다른 역할은 없다.
- 상품 표 칸은 22개다(`shop/adapters/db/schema.ts` 8~34행).
- 파트너 코드(`shop/adapters/db/drizzle-product-store.ts`, `core_partner` 테넌트 트랜잭션):
  - `insert`(88행): 22칸 전부를 적는다(수수료율은 앱이 정한 값).
  - `save`(124행): `UPDATE … SET` 스무 칸(`type`·`schema_version`·`name`·`status`·`price`·`shipping_fee`·`return_shipping_fee`·`return_address`·`limited_qty`·`transferable`·`ticket_linked`·`linked_event_id`·`fulfillments`·`sale_starts_at`·`sale_ends_at`·`commission_rate_bp`·`attributes`·`published_at`·`updated_at`·`version`) `WHERE id·promoter_id·version RETURNING version`. `id`·`promoter_id`는 SET하지 않는다.
- 수수료율을 정하는 곳(`shop/application/products.ts`): 게시로 만들 때(113행)와 처음 게시로 고칠 때(155행)만 `CommissionRateSource.rateBp`를 부른다. 운영 조립은 `DrizzleCommissionRate`(`main.ts` 204행, `promoter_contract`의 기간 끝이 열린 행, 없으면 예외)이고, DB 조립의 기본값은 `FixedCommissionRate(1000)`이다(`shop.module.ts` 108행. `shop-notify.int`·`shop-order.int`가 이 기본값으로 파트너 HTTP 게시를 한다).
- 읽는 곳: 팬 경로 주문 만들기가 `core_app`으로 상품을 읽고 항목에 `p.commissionRateBp ?? 0`을 복사한다(`create-merch-order.ts` 212행).
- 수수료율을 바꾸는 정당한 길: 계약 변경(2인 승인, ADR-0320)은 `promoter_contract`와 판매자·회차 칸만 바꾸고, 이미 게시된 상품 값은 바꾸지 않는다(ADR-0320 결정 6).
- 시험 준비: `shop-cancel`·`shop-return`·`shop-expiry`·`shop-unclaimed`·`shop-refund-account`·`shop-attributes-check`·`shop-migration` 통합 시험은 소유자(`admin`)로 게시 상품을 계약 없이 넣는다(수수료율 1000 또는 비움). 트리거를 파트너 역할에만 거는 까닭이다(3.2).

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
| R9 | 파트너 A: `update product set commission_rate_bp = 0`(조건 빠짐, 테넌트 A) | A의 모든 상품 수수료율이 0이 되고, 그 뒤 주문 항목이 0을 복사해 상품 정산서에 수수료 없이 오른다 | 트리거가 고치기 전 값으로 되돌려 그대로(⑧) |
| R10 | 파트너 A: `insert into product (… status 'PUBLISHED', commission_rate_bp 0 …)` | 수수료 없는 게시 상품이 생긴다 | 트리거가 계약 값으로 정한다(⑧) |
| R11 | 파트너 A: `update product set promoter_id = '<A>'`·`set id = …` | 지금은 판매자 칸이 WITH CHECK로만 막힌다(같은 테넌트 값이면 된다) | 42501(⑧) |

- 다른 파트너 행은 지금도 테넌트 정책이 막는다(R5~R10은 자기 테넌트 안의 돈 값이다). 팬 경로(R1~R4)는 테넌트를 넘는다.

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
4. 상품, 파트너 역할(결정 4)
   - `REVOKE UPDATE ON "product" FROM core_partner` → `GRANT UPDATE (1.6의 스무 칸) ON "product" TO core_partner`(수수료율 칸은 이번에만 남김, 결정 4 '두 번에 나눔'). 넣기·읽기와 `product_partner_tenant`는 그대로.
   - 함수와 트리거(꼴. 식은 ADR-0338 결정 4):

     ```sql
     CREATE OR REPLACE FUNCTION product_commission_from_contract() RETURNS trigger
     LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
     BEGIN
       IF NOT pg_has_role(current_user, 'core_partner', 'MEMBER') THEN RETURN NEW; END IF;
       IF TG_OP = 'UPDATE' AND OLD.commission_rate_bp IS NOT NULL THEN
         NEW.commission_rate_bp := OLD.commission_rate_bp;
       ELSIF NEW.status = 'PUBLISHED' THEN
         NEW.commission_rate_bp := (SELECT c.commission_rate_bp FROM public.promoter_contract c
                                    WHERE c.promoter_id = NEW.promoter_id AND upper_inf(c.valid_during));
         IF NEW.commission_rate_bp IS NULL THEN
           RAISE EXCEPTION '계약 조건이 없어 상품 수수료율을 정할 수 없다' USING ERRCODE = '23514';
         END IF;
       ELSE
         NEW.commission_rate_bp := NULL;
       END IF;
       RETURN NEW;
     END $$;
     DROP TRIGGER IF EXISTS product_commission_from_contract ON public.product;
     CREATE TRIGGER product_commission_from_contract BEFORE INSERT OR UPDATE ON public.product
       FOR EACH ROW EXECUTE FUNCTION product_commission_from_contract();
     ```

5. FORCE·소유자는 바꾸지 않는다(결정 6).

- 쿼리·`schema.ts`는 바꾸지 않는다. 코드는 주석 둘과 상품 저장소의 고치기 한 곳만 바꾼다(5).

#### 3.2 PostgreSQL 동작에서 시험·검증이 알아야 할 것(PostgreSQL 18 CREATE POLICY 문서 '명령별 적용 정책' 표, 2026-11-22 확인)

- UPDATE가 칸을 읽으면(WHERE·RETURNING·SET 식) 읽기 정책이 **고치기 전 행과 고친 뒤 행 모두**에 걸리고, 고친 뒤 행이 읽기 정책을 어기면 조용히 빠지지 않고 오류다. 발송기 끄기는 `WHERE id`와 `version + 1`을 읽으므로, `webhook_endpoint_app_read`를 켜진 끝점으로 좁히면 끄기가 오류로 실패한다(M8). 읽기 몫을 그대로 두는 까닭이다.
- 고치기 정책 USING은 고칠 행을 거르기만 한다(맞지 않는 행은 0행, 오류 없음). WITH CHECK에 걸리면 오류(42501)다. 그래서 ②의 '다시 켜기'는 0행이고, '사유만 바꾸기·판만 올리기'는 오류다.
- 고치기 정책이 하나도 없는 역할의 UPDATE는 권한이 있어도 0행이고 오류가 없다(기본 거부). ⑤는 0행이 아니라 42501을 단언해야 M11(권한만 남김)을 잡는다.
- **겹친 가드를 하나씩**: 웹훅 끝점의 팬 경로 고치기는 칸 권한과 정책이 겹친다. 칸 권한만 보려면(①) 허용된 끄기(`status = 'DISABLED', disabled_reason = 'FAILING'`)를 함께 SET해 정책이 통과하게 하고, 정책만 보려면(②) 허용된 세 칸만 SET한다. 굿즈 주문의 파트너 넣기도 권한과 '넣기 정책 없음'이 겹쳐, 넣기 권한만 남긴 틀린 구현(M17)은 행동으로 보이지 않고 ⑦의 칸 권한 단언만 잡는다.
- 파트너 판매자 칸 고치기는 칸 권한과 테넌트 WITH CHECK가 겹친다. ④는 값을 자기 테넌트로 골라 WITH CHECK가 지나게 해 칸 권한만 본다.
- 소유자·슈퍼유저는 정책을 건너뛴다. 시험 `admin`은 슈퍼유저라 시드·되돌리기를 그대로 한다. FORCE를 더해도 `admin`은 건너뛰어 ⑦만 잡는다(M18).
- 외래 키 검사는 행 보안을 건너뛴다. `id = id`처럼 값이 같은 고치기는 외래 키(`webhook_delivery.endpoint_id`)를 어기지 않는다.
- 상품 트리거: 칸 권한은 문장의 SET 칸으로 문장을 돌리기 전에 보고, BEFORE 트리거는 그 뒤 새 행의 어느 칸이든 바꿀 수 있다(권한과 상관없다). 행 보안 WITH CHECK는 트리거가 바꾼 새 행에 걸린다. 그래서 ⑧은 '수수료율을 적은 문장이 거절되는가'가 아니라 '저장된 값이 무엇인가'를 본다.
- 트리거 함수는 호출자 권한이라 파트너 트랜잭션에서는 `promoter_contract_partner_read`(0033)로 자기 테넌트 계약만 읽는다. 시험 `admin`은 파트너 역할 구성원이 아니어서 트리거가 아무것도 하지 않는다. 그래서 ⑧의 준비·되돌리기를 `admin`으로 해도 값이 덮이지 않고, 계약 없는 게시 상품 시드도 그대로 들어간다.
- 계약 변경은 `admin`으로 지금 기간을 닫고(`upper` 채움) 새 기간을 넣는다(`promoter-contract.int.test.ts` 157~160행 꼴, `WITHOUT OVERLAPS` 유일 제약을 지킨다).

#### 3.3 이전 판 코드(N-1)와 함께 돌기

배포 창 동안 이전 판의 발송기 끄기 문장은 새 세 칸·새 정책 안이고, 파트너 웹훅 고치기의 SET 칸은 아홉 칸 안이다. 파트너 굿즈 주문 쓰기 코드는 이전 판에도 없다. 이전 판 상품 고치기는 수수료율을 포함한 스무 칸 안이고(그래서 그 칸 권한을 이번에 거두지 않는다), 적은 수수료율은 트리거가 덮는다. 이 묶음의 상품 저장소 코드는 수수료율을 SET하지 않으므로 축소 뒤에도 돈다.

### 4. 다른 역할 영향(0042 뒤)

| 역할 | 영향 |
| --- | --- |
| `core_app` 발송기·내부 입구 | 켜진 끝점 찾기·다시 읽기·서명·발송 행 넣기 그대로. 끄기는 켜진 끝점에만 된다. 이미 꺼진(파트너가 끈) 끝점에 끄기를 부르면 0행이라 사유 `PARTNER`가 남는다(지금은 `FAILING`으로 덮는다. 경쟁 상황의 작은 행동 바뀜, ADR-0338 결정 1). `dispatcher.ts` 118행의 `disabled` 목록·알림 훅은 0행이어도 부른다(지금 알림 훅은 비어 있다. 정리 후보 14) |
| `core_app` 팬 굿즈·정산 원천 | 그대로(`*_app_all`, 권한 그대로) |
| `core_partner` 웹훅 | 등록·목록·고치기·재발급·발송 이력·다시 보내기 그대로(SET이 아홉 칸 안). 끝점 ID·판매자 칸만 고치지 못한다 |
| `core_partner` 굿즈 주문 | 자기 테넌트 읽기 그대로. 쓰기 코드가 없어 영향 없음 |
| `core_partner` 상품 | 목록·상세·만들기·고치기·재고 그대로. 수수료율은 앱이 계약에서 읽은 값과 같은 값을 트리거가 정한다. 계약이 없는데 게시하면 앱이 먼저 실패한다(운영 조립). `FixedCommissionRate`로 조립한 시험은 계약 행이 없어 트리거가 23514로 멈추므로, 파트너 HTTP로 게시하는 `shop-notify.int`·`shop-order.int`는 판매자마다 계약 행(수수료율 1000)을 시드에 더한다(6) |
| `core_app` 주문 만들기 | 상품 수수료율을 읽어 복사하는 것 그대로. 읽는 값이 계약 값이다 |
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
| 구현 | `src/modules/shop/adapters/db/drizzle-merch-store.ts` 1행 주석 | 파트너 DB 역할은 두 표를 읽기만 한다(ADR-0338 결정 3·5)(주석만) |
| 구현 | `src/modules/shop/adapters/db/drizzle-product-store.ts` `save`(124~150행) | SET에서 `commissionRateBp`를 빼고 `returning`에 `commissionRateBp`를 더해 돌려주는 기록의 수수료율을 DB 값으로 둔다(ADR-0338 결정 4). `insert`는 그대로(트리거가 덮는다). 메모리 저장소·포트는 그대로 |
| 시험 | `services/core-svc/test-int/webhook-merch-grants.int.test.ts`(새) | AZ-T18 ①~⑧ |
| 시험 | `services/core-svc/test-int/shop-notify.int.test.ts` 95~116행·257~284행, `beforeAll` | 권한 기대값을 0042 뒤 모양으로, 판매자 A·B 계약 행 시드(아래 6 끝) |
| 시험 | `services/core-svc/test-int/shop-order.int.test.ts` `beforeAll` | 파트너 HTTP로 게시하는 판매자의 계약 행 시드(수수료율 1000, 단언은 그대로) |
| 계획(두 커밋) | ADR-0338(새), authz-matrix §5.3·§7, data.md 네 줄, asvs/notify 8.4.1, asvs/settlement 8.2.3 | 정본 빈칸 먼저 |

- 구현 커밋은 시험 파일을, 시험 커밋은 시험 파일·이 계획 밖을 건드리지 않는다(§8.6 '바꾸는 파일').
- 바꾸지 않는 것: 적용된 마이그레이션(0004·0014~0016·0033), `schema.ts`·`packages/platform`, `products.ts`(계약 읽기·실패는 그대로), `rls.int.test.ts`·`roles.ts`, 계약·생성물·화면, ADR-0241, `webhook_delivery`(13.1).

### 6. 시험 목록(시험 담당. 단언 값은 정본에서)

- **준비는 0042에 기대지 않는다**: 시드는 `admin`(슈퍼유저)으로 넣는다. 판매자 A·B, 공연장·공연·회차(A), 끝점 A1(A, 켜짐, 발송 행 없음)·A2(A, 꺼짐 `PARTNER`)·B1(B, 켜짐, 구독 `payout.completed`만이라 ③의 사건을 받지 않음), 발송기용 끝점 E(B, 켜짐, 구독 `order.confirmed`, 옛 비밀과 미래 기한)·F(B, 꺼짐 `PARTNER`), 굿즈 주문 OA1(A, `PAID`·`TOSS`·`STANDARD`·배송비 3,000)과 항목(배송 완료, 단가 15,000 × 2, 수수료 1,000bp, 기준일이 시험 기간 안), OA2(A, `CREATED`)와 항목, OB(B, `PAID`)와 항목. ⑧용: 판매자 A의 계약(`promoter_contract`, 수수료율 1,234bp, 기간 끝이 열림), 계약이 없는 판매자 C.
- 연결: `loginFor`(`test-int/roles.ts`)로 `core_app` 사용자(연결 2)와 `core_partner` 사용자(**연결 하나짜리 풀**: 앞 트랜잭션이 쓴 연결을 다시 쓰는 경우가 저절로 생긴다, rls.int.test.ts 34행 꼴). ⑤의 정산 원천은 `shop-notify.int.test.ts`처럼 `AppModule.register({ database: appDb, partnerDatabase: <다른 파트너 풀>, media: testMedia() })`와 `PEAKET_INTERNAL_TOKEN`으로 띄운 서비스의 `GET /internal/v1/shop/product-settlement-items`를 부른다.
- 42501은 `rejects.toMatchObject({ cause: { code: '42501' } })`. 바꾼 상태는 `afterEach`에서 `admin`으로 되돌린다(구현 전 트리에서 고치기가 되므로 시험이 실패해도 되돌린다, W12-core-rls 시험 담당 꼴). 번호는 `AZ-T18 ①`처럼 ID 바로 뒤에.
- ③의 서명 기대값은 `node:crypto`의 HMAC으로 시험 안에서 따로 만든다(`domain/webhook.ts`의 `webhookSignature`로 만들지 않는다. `test/webhook-dispatcher.test.ts` 39행 시험 꼴). 시계는 가짜 시계, 수신기는 응답 차례를 정한 가짜(그 파일의 `Receiver` 꼴). 이 파일의 다른 발송 행은 DEAD·SUCCEEDED이거나 다음 시도 시각이 미래여서 ③ 말고는 집히지 않게 둔다.
- 시험이 기대는 공개 모양: 정책 이름(ADR-0338 결정 1·3), 트리거·함수 이름(결정 4), 칸 권한(결정 1~4), 계약 없는 게시 오류 23514, 일지 idx 42.

| 시험 이름 | 단언(정확한 값) | 구현 전 트리 |
| --- | --- | --- |
| `AZ-T18 ① 팬 경로 사용자는 허용된 끄기와 함께여도 웹훅 끝점의 주소·비밀·구독·판매자·끝점 ID 칸을 칸마다 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]` | `app`으로 A1에 `set <칸> = <새 값>, status = 'DISABLED', disabled_reason = 'FAILING' where id = A1`을 칸마다 따로: `url`(`https://attacker.example/hook`)·`secret`·`previous_secret`·`previous_secret_valid_until`·`event_types`·`secret_issued_at`·`promoter_id`(= B)·`id`(= `id`). 모두 42501. 끝에 `admin`으로 A1·A2·B1의 모든 칸이 시드 값 그대로 | 실패(고치기가 됨) |
| `AZ-T18 ② 팬 경로 사용자는 켜진 끝점을 FAILING으로 끄는 것 말고는 상태·사유·판을 바꾸지 못하고 꺼진 끝점을 다시 켜지 못한다 [ASVS v5.0.0-8.4.1]` | 가: `set status = 'ACTIVE', disabled_reason = null where id = A2` → 오류 없이 0행, A2는 `DISABLED`·`PARTNER`·판 그대로. 나: A1에 `set disabled_reason = 'PARTNER'` → 42501. 다: A1에 `set status = 'DISABLED', disabled_reason = 'PARTNER'` → 42501. 라: A1에 `set version = version + 1` → 42501. 끝에 A1 그대로 | 실패(가 1행, 나~라 됨) |
| `AZ-T18 ③ 발송기는 팬 경로 사용자로 켜진 끝점을 읽어 서명해 보내고 계속 실패하면 FAILING으로 끄며 이미 꺼진 끝점의 사유는 바꾸지 않는다 [ASVS v5.0.0-8.4.1]` | `admin`으로 E에 DEAD 49건(5일 [가정] 창 안, 성공 없음)을 넣는다. `new WebhookDispatcher({ store: new DrizzleWebhookStore(appDb), transport: <500만 주는 가짜>, clock })`로 `enqueue` 뒤 재시도 간격대로 `processDue` 일곱 번. 가짜 수신기가 받은 요청이 일곱이고 모두 E의 주소, `webhook-signature`가 지금 비밀·옛 비밀 두 서명(시험에서 따로 만든 값과 같음). 마지막에 그 발송 행 DEAD, E는 `DISABLED`·`FAILING`·판 2, 알림 훅 1번. 이어서 `store.disableEndpoint(F)`가 오류 없이 끝나고 F는 `DISABLED`·`PARTNER`·판 1 그대로, `store.findEndpointById(F)`는 F를 돌려준다 | 실패(F가 `FAILING`·판 2로 바뀜). 나머지는 통과 → M6~M8 |
| `AZ-T18 ④ 파트너 트랜잭션은 자기 테넌트 끝점만 읽고 고치며 자기 끝점이라도 판매자·끝점 ID 칸은 고치지 못한다 [ASVS v5.0.0-8.4.1] [ASVS v5.0.0-8.2.3]` | 테넌트 A: 조건 없는 읽기의 ID가 정렬해 정확히 `[A1, A2]`(비밀 칸도 읽힘). WHERE·RETURNING 없는 `set url = 'https://a2.example.com/hook'` 뒤 `admin`으로 A1·A2만 바뀌고 B1·E·F는 그대로. A 트랜잭션을 돈 뒤 테넌트 없는 트랜잭션 읽기 `[]`·고치기 오류 없이 0행, 트랜잭션 밖 읽기 `[]`. A1에 `set promoter_id = A`·`set id = id` 각각 42501. A1에 아홉 칸을 모두 새 값으로(`version = version + 1`) `where id = A1 returning id` → `[{ id: A1 }]`. `promoter_id = B` 넣기 42501 | 실패(판매자·끝점 ID 고치기가 됨). 나머지는 통과 → M9·M10 |
| `AZ-T18 ⑤ 파트너 트랜잭션은 자기 테넌트의 굿즈 주문·주문 항목을 넣거나 칸마다 고치거나 지우지 못하고 상품 정산 원천 응답이 그대로다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]` | 먼저 정산 원천 응답을 받아 둔다(OA1 항목: 총액 33,000·수수료 1,000bp). 테넌트 A로 WHERE·RETURNING 없는 고치기를 칸마다 따로: 항목 `unit_amount`(15,001)·`quantity`(3)·`commission_rate_bp`(0)·`refunded_amount`·`status`(`CANCELLED`)·`shipped_at`·`delivered_at`·`tracking_no`, 주문 `status`(`PAID`)·`shipping_fee`(0)·`pg`·`purchase_confirmed_at`·`amount`. 모두 42501(0행이 아니라 오류). `PAID` 주문·그 항목 넣기 각각 42501, 두 표 지우기 각각 42501. 끝에 정산 원천 응답이 처음과 깊이 같고, `admin`으로 두 표의 모든 행이 시드 값 그대로 | 실패(고치기·넣기가 되고 응답이 바뀜) |
| `AZ-T18 ⑥ 파트너 트랜잭션의 굿즈 주문·주문 항목 읽기는 자기 테넌트 행뿐이고 테넌트 없이는 0건이다(앞 트랜잭션이 쓴 연결을 다시 써도 오류 없이) [ASVS v5.0.0-8.4.1]` | 테넌트 A의 조건 없는 읽기 ID가 두 표 모두 정확히 A의 행(OA1·OA2와 그 항목), B는 OB와 그 항목. A 트랜잭션 뒤 테넌트 없는 트랜잭션 `[]`(22P02 없이), 트랜잭션 밖 `[]` | 통과(있던 동작) → M14~M16 |
| `AZ-T18 ⑦ 세 표의 행 보안이 켜져 있고 FORCE가 없으며 소유자가 앱 역할이 아니고 정책과 칸 권한이 정한 모양이다 [ASVS v5.0.0-8.4.1]` | `pg_class` 세 표 `relrowsecurity` 참·`relforcerowsecurity` 거짓, 소유자가 세 앱 역할·로그인 사용자 아님. `pg_policies`(`roles::text[]`)를 표·이름 차례로 정확히: `webhook_endpoint` = `webhook_endpoint_app_disable`(UPDATE, `{core_app}`, `qual`·`with_check`가 결정 1의 식), `webhook_endpoint_app_read`(SELECT, `{core_app}`, `true`, 없음), `webhook_endpoint_partner_tenant`(ALL, `{core_partner}`, 0015의 테넌트 식 그대로); `merch_order` = `merch_order_app_all`(ALL, `{core_app}`, `true`, `true`), `merch_order_partner_read`(SELECT, `{core_partner}`, `qual`이 `production_partner_tenant`의 `qual` 글과 같음, 없음); `merch_order_item`도 같은 꼴. `has_table_privilege`·`has_column_privilege`로 `core_app`의 끝점 UPDATE는 표 단위 거짓·칸은 셋만 참, `core_partner`의 끝점 UPDATE는 표 단위 거짓·칸은 아홉만 참, `core_partner`의 두 주문 표 INSERT·UPDATE는 표 단위·모든 칸 거짓이고 SELECT는 참 | 실패(옛 정책·표 단위 권한) |
| `AZ-T18 ⑧ 파트너 트랜잭션이 상품 수수료율을 적어 넣거나 고쳐도 게시 때의 계약 값으로 정해지고 그 뒤 바뀌지 않으며 상품 ID·판매자 칸은 고치지 못한다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-8.4.1]` | 테넌트 A로 가: 수수료율 0을 적은 게시 상품 P1 넣기 → `admin`으로 1,234. 나: 수수료율 5를 적은 초안 P2 넣기 → 비어 있음. 다: `set status = 'PUBLISHED', commission_rate_bp = 7 where id = P2` → 1,234. 라: WHERE·RETURNING 없는 `set commission_rate_bp = 0` → P1·P2 1,234 그대로. 마: `admin`으로 A의 계약을 2,000bp 새 기간으로 바꾼 뒤 `set name = '…' where id = P1` → P1은 1,234, 새 게시 상품 P3 넣기 → 2,000. 바: 테넌트 C로 게시 상품 넣기 23514, 초안 넣기는 되고 비어 있음. 사: P1에 `set promoter_id = A`·`set id = id` 각각 42501. 아: `app`으로 P1·P3 수수료율이 1,234·2,000. 자: `pg_trigger`에 `product_commission_from_contract`(BEFORE, INSERT·UPDATE, 행마다, 켜짐), 그 함수 `prosecdef` 거짓·`proconfig`에 `search_path=pg_catalog, pg_temp`. `has_table_privilege(core_partner, product, UPDATE)` 거짓, 칸은 1.6의 스무 칸만 참(상품 ID·판매자 거짓), INSERT는 표 단위 참 | 실패(가·다·라·마·사·자에서 적은 값이 남고 표 단위 권한) |

- **기존 시험 고침(같은 시험 커밋)**: `shop-notify.int.test.ts` 95행 시험의 `core_partner` 기대값 `product`·`webhook_endpoint`를 `INSERT,SELECT`로, 257행 시험의 `merch_order`·`merch_order_item`을 `SELECT`로, `core_app` `webhook_endpoint`를 `SELECT`로 바꾸고 '표 단위 권한만 본다. 칸 권한은 AZ-T18 ⑦'이라는 주석 한 줄. 시험 이름·다른 단언은 그대로. 구현 전 트리에서는 이 두 시험도 실패한다. 또 `shop-notify.int`·`shop-order.int`의 `beforeAll`에 파트너 HTTP로 게시하는 판매자마다 계약 행(수수료율 1000, 기간 끝이 열림)을 `admin`으로 넣는다. 지금 조립의 `FixedCommissionRate(1000)`와 같은 값이라 다른 단언은 그대로이고, 구현 전 트리에서도 통과한다.
- 회귀(게이트에서 돈다): `shop-notify.int`(파트너 웹훅 HTTP 등록·고치기·재발급·이력·다시 보내기, 내부 입구, 정산 원천), `webhook-lease.int`·`webhook-lease-concurrent.int`, `shop-order.int`·`shop-cancel.int`·`shop-return.int`·`shop-expiry.int`·`shop-unclaimed.int`·`shop-refund-account.int`(팬 경로 쓰기), `shop-migration.int`, `shop-attributes-check.int`(소유자 시드가 트리거를 건너뛰는지), `promoter-contract.int`(계약 변경·상품 게시 수수료율 원천), `rls.int`(W12-core-rls), W12-core-idem 새 파일 셋, `test/webhook-dispatcher.test.ts`, `test/migrations-journal.test.ts`, `test/shop-notify.migration.test.ts`.

### 7. 실패 확인(시험 담당)

- **어디서**: 두 앞 묶음이 develop에 든 뒤 rebase하고, 시험 커밋을 이 계획 커밋 위에 쌓은 트리(0042 없음).
- **길 (가) 로컬 Docker**(감독이 갈래 2 차례를 줄 때만): `docker info` → `bash D:/ticketpass-locks/lock.sh take docker lane2-W12-core-rls2`(남이 쥐었으면 `who`를 적고 기다리지 말고 길 (나)) → `pnpm exec turbo run build --filter=@peaket/core-svc^...` → `pnpm --filter @peaket/core-svc test:integration test-int/webhook-merch-grants.int.test.ts test-int/shop-notify.int.test.ts test-int/shop-order.int.test.ts` → 자기 컨테이너만 `docker rm -f -v` → `lock.sh drop docker lane2-W12-core-rls2`.
- **길 (나) 초안 PR CI**(기본): 시험 커밋을 올리고(rebase 뒤라 `feature/lane2-W12-core-rls2-r2`) `gh pr create --draft --base develop --head <가지>`로 초안 PR을 연다. `ci.yml` → `ci-node.yml`의 `node` 잡이 core-svc 통합 시험 전부를 돈다(92행). `gh run view <실행 ID> --log-failed`로 그 잡의 실패 시험과 실제 값을 읽는다. 다른 통합 시험이 실패하면 이 묶음과 관계없는 것인지 적는다.
- **기대**: ①②③④⑤⑦⑧과 고친 `shop-notify` 두 시험이 **단언 실패**(실행조차 안 되는 실패가 아니다). ⑥은 통과(있던 동작)이고 M14~M16으로, ③의 발송 몫과 ④의 아홉 칸은 M6~M8·M10으로 본다(§8.6 7 '구현 전 트리에서 실패를 볼 수 없는 시험').
- **적을 것**: 길, 명령(또는 실행 ID), 파일마다 통과·실패 수, 실패마다 실제 값 한 줄, 처음부터 통과한 시험과 그 실패를 볼 표본 번호, 잠금 시각(길 가).

### 8. 틀린 구현 표본(검증 담당, 24개, 항목마다 1개 이상)

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
| M19 | ⑧ | 0042 | 트리거를 만들지 않는다(함수와 칸 권한만) | ⑧가·다·라·자 |
| M20 | ⑧ | 0042 | 고치기 분기에서 고치기 전 값을 지키지 않는다(게시면 늘 지금 계약 값) | ⑧마(P1이 2,000이 됨) |
| M21 | ⑧ | 0042 | 계약이 없을 때 멈추지 않고 비워 둔다 | ⑧바(게시 상품이 수수료율 없이 들어감) |
| M22 | ⑧ | 0042 | 트리거를 `BEFORE UPDATE`만 건다 | ⑧가(넣기에 적은 0이 남음)·자 |
| M23 | ⑧ | 0042 | `core_partner`의 상품 `REVOKE UPDATE`를 빼고 칸 권한을 주지 않는다(표 단위 그대로) | ⑧사·자 |
| M24 | ⑧ | 0042 | 함수를 `SECURITY DEFINER`로 만든다 | ⑧자만(행동은 같다. 정의자 권한은 행 보안을 건너뛰어 다른 테넌트 계약을 읽을 수 있다) |

- 항목마다 수: ① 2, ② 3, ③ 3, ④ 2, ⑤ 3, ⑥ 3, ⑦ 2, ⑧ 6. 정책 식 칸 이름을 틀리면 0042가 42703으로 멈춰 모든 통합 시험이 멈추므로 세지 않는다. 장애 주입은 해당 없음(복구 경로가 없는 권한 변경).
- '검증' 절에 적을 것: 표본마다 실패한 시험, 놓친 표본과 시험 담당에게 넘긴 것, AZ-T18 ①~⑧ 판정 기준과 단언의 대조 전수.

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
| `lint-guard` | core-svc 상품 저장소(어댑터 층)와 주석 |

- spec-check: `specs/specs.json`이 바꾸는 문서를 가리키지 않아 해당 없음.
- 장부: BUILD_ORDER 묶음이 아니라 `ledger.mjs --batch`는 쓰지 않는다. 지금 `node tools/ci/ledger.mjs --scope AZ-T18`은 항목 8·빈칸 8·등급 B다. 감독 결정으로 A로 증명한다. 기록 담당이 `node tools/ci/ledger.mjs`로 다시 쓰고 AZ-T18 ①~⑧이 '자동 시험'인지 본다.
- `pnpm`이 막히면 `npx tsc -p services/core-svc/tsconfig.json --noEmit`, `npx vitest run --config vitest.integration.config.mjs <파일>`(core-svc 폴더).
- 리뷰(보안): 정책 식과 칸 목록(1.2 표·ADR-0338), REVOKE·GRANT 차례, 다른 역할 경로(4 표), 발송기 몫이 끄기 하나로 좁혀졌는지와 읽기 몫을 좁히지 않았는지(3.2), 상품 트리거의 역할 조건·호출자 권한·`search_path`·계약 없는 게시, 수수료율 칸 권한을 남긴 까닭(두 번에 나눔), FORCE·소유자, N-1(3.3), 시험이 쿼리 조건 없이 DB 가드만 보고 겹친 가드를 하나씩 보는지.

### 10. 자주 놓친 결함 가운데 해당하는 것

- 정확한 값까지: ①④⑥ 보이는·바뀐 행 목록 전체, ③ 보낸 요청 수·주소·서명 값·끈 끝점의 사유와 판, ⑤ 정산 원천 응답 전체와 모든 행 값.
- 경계·세 상태: 테넌트 있음(④⑥)·없음·빈 문자열(연결 재사용, ④⑥). 실패 기준 49건 + 1(③, 값은 notify.md §9 [가정]). 수수료율 처음 정하기·이미 정함·초안(⑧), 계약 있음·바뀜·없음(⑧).
- 겹친 가드 하나씩: 칸 권한과 정책(①은 허용 끄기와 함께, ②는 허용 칸만, 3.2), 판매자 칸 권한과 WITH CHECK(④는 자기 테넌트 값), 넣기 권한과 넣기 정책 없음(M17은 ⑦).
- 목록 밖 값마다: ① 칸마다, ② 상태·사유·판 경우마다, ⑤ 정산 칸마다.
- 부르는 쪽이 결과를 쓰는지: ③은 실제 발송기를 `core_app`으로 돌려 수신기가 받은 요청을 보고, ⑤는 정산 원천 HTTP 응답을 견준다. ⑧은 팬 경로 사용자가 읽는 상품 수수료율(주문이 복사하는 값)을 본다. 시험 값은 상수와 다르게(단가 15,001, 수량 3, 계약 1,234bp·2,000bp는 기본값 1000과 다르게).

### 11. 범위 밖

발송 원장·발송기 전용 DB 역할(13.1, W12-core-notify), 상품 수수료율 칸 권한 축소(13.2), 상품의 다른 칸(가격 등 파트너가 정하는 값), 아래 14의 정리 후보, 파트너 배송·반품 처리 서버(ADR-0338 결정 4의 선만 정함), 파트너의 주문 읽기 칸 좁히기, `disableEndpoint`가 0행일 때의 보고, 계약·화면.

### 12. WBS 일 [가정]

1.8일 = 계획 0.25(감독 결정 둘째 반영 포함) + 시험 0.55(새 통합 파일 하나와 ⑧, HTTP 조립 하나, 기존 단언 둘, 계약 시드 둘) + 구현 0.3(마이그레이션·트리거·상품 저장소 고치기·주석) + 리뷰 0.2 + 검증 0.4(표본 24개) + 기록 0.1. 감독이 coord.md에 적는다.

### 13. 넘기는 것

#### 13.1 W12-core-notify(갈래 3, 감독 결정 2026-11-22): 발송 원장과 발송기 전용 DB 역할

- **위험**: 발송기가 팬 경로 역할 `core_app`으로 붙는다(1.3). 그래서 팬 경로 쿼리 하나로
  - 발송 원장 `webhook_delivery`에 아무 끝점·아무 본문의 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다(가짜 주문 확정·지급 완료). **높음**.
  - 원장 행의 상태를 고쳐 진짜 사건을 DEAD로 만들거나, 끝난 행을 PENDING으로 되돌려 다시 보낸다.
  - 모든 끝점의 비밀을 읽는다(notify.md §13 '발송 워커의 서비스 계정만 비밀을 읽는다'와 다르다). 켜진 끝점을 `FAILING`으로 끈다(0042 뒤에 남는 가용성 위험).
- **지금 권한**(`core_app`): `webhook_endpoint` 읽기(0004 25행 기본 권한)·`webhook_endpoint_app_read`(0015 50행), 0042 뒤 고치기 세 칸·`webhook_endpoint_app_disable`. `webhook_delivery` 읽기(기본 권한)·`INSERT, UPDATE`(0016 77행)·`webhook_delivery_app_read`(0015 52행)·`webhook_delivery_app_all` FOR ALL `true`(0016 105행).
- **발송기가 실제로 쓰는 것**(`notify/adapters/db/drizzle-webhook-store.ts`, `dispatcher.ts`. `main.ts` 249행의 주기 작업과 내부 입구 `POST /internal/v1/notify/webhook-events`가 `NOTIFY_APP_STORE`로 같은 저장소를 쓴다):

| 메서드(행) | 표 | 명령 | 읽는 칸(WHERE·RETURNING 포함) | 쓰는 칸 |
| --- | --- | --- | --- | --- |
| `listActiveEndpoints`(156) | `webhook_endpoint` | SELECT | 11칸 전부(조건 `promoter_id`·`status`) | — |
| `findEndpointById`(163) | `webhook_endpoint` | SELECT | 11칸 전부(조건 `id`) | — |
| `disableEndpoint`(251) | `webhook_endpoint` | UPDATE | `id`·`version` | `status`·`disabled_reason`·`version` |
| `insertDeliveries`(170) | `webhook_delivery` | INSERT | — | 표 객체의 모든 칸(Drizzle이 `lease_until`도 기본값으로 적는다) |
| `listDueDeliveries`(192) | `webhook_delivery` | SELECT … FOR UPDATE SKIP LOCKED → UPDATE … RETURNING | `id`·`status`·`next_attempt_at`·`lease_until`, 돌려받기는 모든 칸 | `lease_until` |
| `saveDelivery`(220) | `webhook_delivery` | UPDATE | `id`·`status` | `status`·`attempt_count`·`last_http_status`·`last_error`·`next_attempt_at`·`finished_at`·`lease_until` |
| `countDeadSince`(230) | `webhook_delivery` | SELECT count | `endpoint_id`·`status`·`finished_at`·`created_at` | — |
| `lastSuccessAt`(240) | `webhook_delivery` | SELECT max | `endpoint_id`·`status`·`finished_at` | — |

- 팬 경로의 다른 코드는 두 표를 읽지도 쓰지도 않는다(`grep -rn "webhookDelivery\|webhook_delivery\|webhookEndpoint" services/core-svc/src`가 notify 모듈만 준다). 파트너 경로(`core_partner`)는 끝점 관리와 다시 보내기(`redeliver` 134행, 원장 상태 되돌리기)를 그대로 쓴다.
- **`core_app`에서 거둘 것**(새 역할로 옮긴 뒤): 두 표의 읽기(기본 권한으로 받은 것), `webhook_endpoint` 고치기 세 칸, `webhook_delivery` 넣기·고치기, 정책 넷(`webhook_endpoint_app_read`·`webhook_endpoint_app_disable`·`webhook_delivery_app_read`·`webhook_delivery_app_all`).
- **새로 둘 것(후보)**: 그룹 역할 `core_notify`(로그인 불가, `NOBYPASSRLS`)와 위 표의 명령·칸만큼의 권한·정책, 연결 `PEAKET_NOTIFY_DATABASE_URL`과 풀, 시작 확인(`assertDatabaseRole`, ADR-0241 결정 7), `NotifyModule`의 `NOTIFY_APP_STORE` 주입, 시험 `test-int/roles.ts`의 역할 목록, 로컬·CI·배포 값의 주소, authz-matrix §5.3·notify.md §13 문장.
- **배포 나누기**: 이전 판은 `core_app`으로 두 표를 쓰므로, 새 역할·권한·연결과 코드를 먼저 내고 `core_app` 권한을 다음 배포에서 거두는 두 번 나눔이 devops.md §7.1에 맞아 보인다. 정하는 것은 갈래 3 계획이다.
- 묶음 줄(BUILD_ORDER '기능 묶음' 표)은 이 묶음 기록 커밋에서 감독이 더한다.

#### 13.2 상품 수수료율 칸 권한 축소(ADR-0338 결정 4 '두 번에 나눔')

- 이 묶음의 코드(상품 저장소가 수수료율을 SET하지 않음)가 배포된 뒤 첫 core-svc 마이그레이션이 `REVOKE UPDATE ("commission_rate_bp") ON "product" FROM core_partner` 한 줄을 낸다. 그때 AZ-T18 ⑧ 자의 칸 목록 단언에서 수수료율을 뺀다.
- 그동안에도 트리거가 쓰이는 값을 정하므로 돈 위험은 0042로 닫힌다. 이 줄을 정리 목록에 적는 것은 기록 담당이다.

### 14. 정리 목록 후보(중간·낮음, 고치지 않음, ADR-0283 결정 6)

| 표·칸 | 누가 무엇을 | 위험 한 줄 |
| --- | --- | --- |
| `merch_order` 개인정보 칸 | `core_partner` 표 단위 읽기(0016 71행, 0042 뒤에도) | 자기 테넌트 주문의 받는 분 이름·연락처·주소·구매 계정·결제 ID 원문을 DB에서 읽는다. 계약은 가린 값과 접속기록이 남는 보기만 준다. 중간 |
| `attendee_export` | `core_partner` `SELECT, INSERT, UPDATE` 표 단위(0016 73행), 코드는 넣기만(`drizzle-export-store.ts` 31행) | 파트너 경로 쿼리 하나로 자기 테넌트 내려받기 이력의 건수·결과를 고친다(접속기록 무결성). 낮음~중간 |
| `core_app` 기본 읽기 권한 | 0004 25행 `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES TO core_app` | 뒤에 만드는 모든 표를 팬 경로 역할이 읽는다(웹훅 비밀이 그렇게 열렸다). 새 표마다 거둘 것을 잊기 쉽다. 낮음~중간(구조) |
| data.md `merch_order_item` | 문서가 `unit_price`라 적고 칸 일부(`promoter_id`·`event_id`·`product_name`·`fulfillment`·`ticket_linked`·`shipped_at`·`refunded_amount`·`event_ends_at` 등)가 빠져 있다 | 정본과 0016·코드가 어긋난다. 이번에는 `unit_price` 줄에 실제 이름만 적었다. 낮음(문서) |
| 파트너 굿즈 주문 계약 경로 | `gw-partner` 라우트가 `/v1/partner/merch-order-items` 등을 core-svc로 보내지만 서버 처리기가 없다 | 화면이 실제 서버에서 404를 받는다. 서버를 만들 때 ADR-0338 결정 5를 따른다. 낮음(기능 빈칸). 갈래 5 |
| `dispatcher.ts` 118행 | 끄기가 0행이어도 `disabled`에 넣고 알림 훅을 부른다 | 0042 뒤 경쟁 상황에서 꺼지지 않은 끝점을 껐다고 보고할 수 있다(지금 알림 훅은 비어 있다, ADR-0338 결정 1 '행동 바뀜'). 낮음 |

## 실패 확인

시험 담당(세션 `lane2-w12corerls2-test`)이 2026-11-22에 위 7의 **길 (나) 초안 PR CI**로 돌렸다(감독 지시로 로컬 Docker는 쓰지 않음, 잠금·컨테이너 건드리지 않음). 트리는 develop `d0a72e8a2` 위로 다시 쌓은 이 가지의 계획 커밋 둘 위에 시험 커밋 `15962e965`만 얹은 것(구현 전, 0042 없음)이다. W12-core-idem은 아직 develop에 없어 그 새 시험 파일 셋은 이 트리에 없다.

- **정적 검사**: core-svc `tsc --noEmit`(`tsconfig.json`이 `test-int`를 포함) 통과, `pnpm lint` 통과(`test-int`는 뿌리 린트 범위 밖).
- **명령**: 가지 `feature/lane2-W12-core-rls2`를 올리고 초안 PR #59(`--base develop`)를 열었다. `ci` 실행의 `node / node` 잡 첫 시도는 core-svc 앞 단계 `pnpm --filter @peaket/platform test:integration`에서 이 묶음과 관계없는 두 시험(I-T48 ③ Kafka `Message timed out`, D-T50 ⑦ 테넌트 한도 키 `599`≠`600`)이 흔들려 core-svc 통합 시험까지 가지 못했다. `gh run rerun --failed`로 다시 돌린 둘째 시도에서 platform 18/18·identity-svc 32/32 파일이 통과했고 `pnpm --filter @peaket/core-svc test:integration`이 돌았다(20:03~20:06 UTC). purchase-svc 통합 단계는 core-svc 실패로 돌지 않았다(GAT080_0014·GAT-110 P3·V-T40 기존 실패는 이번에 보지 않음). 잡 끝의 `asvs-report` 단계 끝 코드 2(`test-report-search-golden.json`이 vitest JSON이 아님)는 실패 뒤 정리 단계이고 이 묶음 파일과 관계없다.
- **결과**: core-svc 파일 49개 중 2개 실패·46개 통과·1개 건너뜀(`local-partner-stack.int`, 원래 건너뜀). 시험 500개 중 **17개 실패·482개 통과·1개 건너뜀**. 실패 17개는 모두 아래 표의 단언 실패이고(실행조차 안 되는 실패 없음), 그 밖의 파일은 모두 통과했다(`shop-order.int` 23/23, `rls.int` 24/24, `promoter-contract.int` 14/14, `shop-cancel`·`shop-return`·`shop-expiry` 포함).

| 시험 | 결과 | 실제 값(구현 전 트리) |
| --- | --- | --- |
| AZ-T18 ① | **실패(단언)** | 여덟 칸 고치기가 모두 `1`행(기대 `42501`), A1이 `DISABLED`·`FAILING`·주소 `https://attacker.example/hook`·판매자 B로 바뀜 |
| AZ-T18 ② | **실패(단언)** | 가~라가 모두 `1`행(기대 0·`42501`·`42501`·`42501`), A2가 `ACTIVE`·사유 없음으로 다시 켜지고 A1이 `DISABLED`·`PARTNER`·판 2 |
| AZ-T18 ③ | **실패(단언)** | 발송·서명 일곱 번·DEAD·E의 `FAILING` 끄기·알림 훅 1번은 통과, F가 `PARTNER`·판 1이 아니라 `FAILING`·판 2(`findEndpointById(F)`도 같음) |
| AZ-T18 ④ | **실패(단언)** | 판매자·끝점 ID 칸 고치기가 `1`행(기대 `42501`). 자기 테넌트 읽기 `[A1, A2]`·조건 없는 고치기 2행·테넌트 없이 0건·B 판매자 넣기 `42501`·아홉 칸 고치기 `[{ id: A1 }]`는 기대대로 |
| AZ-T18 ⑤ | **실패(단언)** | 항목 여덟 칸·주문 다섯 칸 고치기가 모두 `2`행, PAID 주문·항목 넣기 `1`행(지우기 둘은 이미 `42501`). 정산 원천 응답이 A 항목 수수료 0·꾸민 주문 50,000원 항목으로 바뀜. 시작 응답(A 33,000원·1000bp, B 20,000원)은 기대대로 |
| AZ-T18 ⑥ | 통과 | 있던 동작. 실패는 검증의 M14~M16으로 본다 |
| AZ-T18 ⑦ | **실패(단언)** | 정책이 옛 `merch_order_partner_tenant`·`merch_order_item_partner_tenant`(ALL)·`webhook_endpoint_app_write`(UPDATE `true`)이고, `core_app`·`core_partner`의 끝점 고치기가 표 단위 `true`(칸 열하나 모두), 파트너의 두 주문 표 넣기·고치기가 표 단위 `true`(칸 전부) |
| AZ-T18 ⑧가 | **실패(단언)** | 게시 상품 수수료율 `0`(기대 1,234) |
| AZ-T18 ⑧나 | **실패(단언)** | 초안 수수료율 `5`(기대 비움) |
| AZ-T18 ⑧다 | **실패(단언)** | 게시로 고친 초안 `7`(기대 1,234) |
| AZ-T18 ⑧라 | **실패(단언)** | 조건 없는 고치기 2행 뒤 P1 `0`·P2 `0`(기대 1,234·비움) |
| AZ-T18 ⑧마 | **실패(단언)** | 계약 변경 뒤 P1 1,234는 기대대로, P2 `1`·P3 `9`(기대 2,000·2,000) |
| AZ-T18 ⑧바 | **실패(단언)** | 계약 없는 판매자의 게시 넣기가 `1`행(기대 `23514`), 저장 행 둘 |
| AZ-T18 ⑧사 | **실패(단언)** | 판매자·상품 ID 칸 고치기가 `1`행(기대 `42501`) |
| AZ-T18 ⑧아 | **실패(단언)** | 팬 경로 주문 저장소가 읽은 P4 `0`·P5 `9`(기대 1,234·2,000) |
| AZ-T18 ⑧자 | **실패(단언)** | 상품 표 트리거 `[]`, 파트너 상품 고치기 표 단위 `true`(칸 22개, 상품 ID·판매자 포함) |
| shop-notify '0014·0015가 …' | **실패(단언)** | `core_partner`의 `product`·`webhook_endpoint` 표 단위 권한이 `INSERT,SELECT,UPDATE`(기대 `INSERT,SELECT`) |
| shop-notify '0016이 …' | **실패(단언)** | `core_partner`의 두 주문 표가 `INSERT,SELECT,UPDATE`(기대 `SELECT`). `core_app` 끝점 단언은 앞 단언에서 멈춰 보지 못함 |

- **처음부터 통과한 시험과 실패를 볼 표본**: ⑥ → M14·M15·M16. ③의 발송·끄기 몫 → M6·M7·M8(③에서 실패한 것은 F 몫뿐). ④의 아홉 칸 → M10. `shop-notify`·`shop-order`의 계약 시드는 구현 전 트리에서도 통과한다(기대대로).
- **시험 쓰기에서 계획과 다르게 한 것**(단언을 약하게 한 것은 없다):
  - ⑧은 시험 하나가 아니라 가~자 아홉 개로 나눴다(이름 `AZ-T18 ⑧가` 꼴, 장부는 ⑧로 센다). 시험마다 시드를 새로 넣어 앞 단계 실패가 뒤 단계를 가리지 않는다. P1(게시 1,234)·P2(초안)는 `admin`으로 넣는다. 그래서 라는 P1 1,234·P2 비움(초안 분기)을 보고, 마는 계약 변경 뒤 P2를 처음 게시해 2,000이 되는 것도 본다. 아는 `DrizzleShopOrderStore.products`(팬 주문 만들기가 수수료율을 복사해 오는 읽기)로 읽는다.
  - 되돌리기는 `afterEach`가 아니라 `beforeEach`의 시드 다시 넣기(네 표 지우고 넣기)다. 실패한 시험의 변경도 다음 시험 전에 지워진다.
  - ③의 서명 기대값은 받은 본문 글로 따로 만든 HMAC이다. 발송 본문이 jsonb를 거쳐 키 차례가 바뀌므로 본문 글을 시험에서 다시 만들지 않고, 본문 내용은 따로 깊이 같음으로 본다.
  - ⑤는 꾸민 PAID 주문과 그 주문의 배송 완료 항목을 넣는다. 시작 응답은 B 항목까지 정확한 값으로 본다.
  - ⑦은 계획 목록에 더해 `core_app`의 두 주문 표 읽기·넣기·고치기가 그대로인지와 `core_partner`의 끝점 읽기·넣기를 본다. 시드 A2의 판은 3이다(판 그대로를 1이 우연히 남는 것과 가르려고).
- **구현 담당에게(시험이 찾은 것)**:
  - **3.2의 '시험 `admin`은 파트너 역할 구성원이 아니어서 트리거가 아무것도 하지 않는다'는 틀리다.** PostgreSQL의 `pg_has_role(…, 'MEMBER')`은 `is_member_of_role`을 쓰고, 그 함수는 슈퍼유저를 모든 역할의 구성원으로 본다(PostgreSQL 18 `src/backend/utils/adt/acl.c`, 2026-11-22 확인). 시험 `admin`(`postgres`)은 슈퍼유저라, ADR-0338 결정 4의 식 그대로면 `admin`의 상품 넣기·고치기에도 트리거가 돈다. 그러면 계약 없이 게시 상품을 `admin`으로 넣는 `shop-cancel`·`shop-return`·`shop-expiry`·`shop-unclaimed`·`shop-refund-account`·`shop-attributes-check`·`shop-migration` 통합 시험(그리고 W12-core-idem의 `shop-replay`)이 23514로 멈추고, 계약이 있는 판매자면 시드한 수수료율이 계약 값으로 덮인다. 결정 4 '소유자가 돌리는 … 시험 준비는 그대로다'와 어긋나므로 식을 고칠지(예: 슈퍼유저를 빼는 조건) 계획·감독이 정할 일이다. 이 묶음의 새 시험 파일은 `admin` 시드를 계약 값과 같게 넣어 어느 쪽이든 그대로 돈다.
  - ⑦의 `webhook_endpoint_app_disable` 식은 PostgreSQL이 다시 쓴 글로 본다(`(status = 'ACTIVE'::text)`, `((status = 'DISABLED'::text) AND (disabled_reason = 'FAILING'::text))`). ADR-0338 결정 1의 식을 그 꼴 그대로 쓴다(`IN` 목록 등 다른 꼴은 다른 글이 된다).
  - 13.2의 축소 마이그레이션이 수수료율 칸 고치기를 거두면 ⑧다·라·마(수수료율을 SET한다)의 결과가 `42501`로 바뀐다. 그때 ⑧자 칸 목록과 함께 그 셋의 기대값도 고친다.

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
| plan | lane2-w12corerls2-plan | claude-opus-5-5 | 2026-11-22T02:26+09:00 | 2026-11-22T03:14+09:00 |
| test | lane2-w12corerls2-test | claude-opus-5-5 | 2026-11-22T04:31+09:00 | 2026-11-22T05:15+09:00 |

## 기록

(기록 담당이 쓴다.)

- **다음 단계**: 감독이 '실패 확인'의 트리거 슈퍼유저 문제(식을 고칠지)를 정한 뒤, 구현 담당이 위 5대로 0042·상품 저장소·주석을 쓰고 초안 PR #59 CI에서 `webhook-merch-grants.int`·`shop-notify.int`와 위 6의 회귀가 통과하는지 본다.
