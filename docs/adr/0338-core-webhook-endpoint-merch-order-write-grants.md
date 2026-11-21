# ADR-0338: core-svc 웹훅 끝점·굿즈 주문·상품 수수료율의 앱 역할 쓰기 권한을 칸과 상태로 좁힌다(2026-11-22)

- **상태**: 채택(2026-11-22, 감독 결정. 방향 '팬 경로 역할의 웹훅 끝점 표 단위 고치기와 조건 없는 정책을 거두고, 파트너는 자기 테넌트 끝점만 고치며, 발송기 몫은 따로 둔다. 파트너의 굿즈 주문 표 단위 고치기를 거두고 단가·수수료율은 파트너가 고치지 못하게 한다'는 감독이 정했고, 세부는 W12-core-rls2 계획 담당의 추천 적용이다. 같은 날 감독 결정 둘째로 상품 표의 파트너 고치기와 상품 수수료율(결정 4)을 이 결정에 넣었고, 발송 원장과 발송기 전용 DB 역할은 새 묶음 W12-core-notify로 뗐다. 셋째로 결정 4의 트리거 조건에서 슈퍼유저를 뺐다)
- **관련**: [ADR-0241](0241-core-svc-partner-row-security.md) 결정 1·3·4·5·6·7과 '다른 선택지', [ADR-0320](0320-promoter-contract-terms-approval-and-freeze.md) 결정 6, [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md) 결정 4, [ADR-0109](0109-delivery-jobs-in-postgres-drop-bullmq-cache-redis-key-classes-noeviction.md), [ADR-0101](0101-product-catalog-postgres-jsonb-drop-mongodb.md), [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md) 결정 9, [ADR-0327](0327-sale-review-request-and-sale-open.md)(W12-core-rls가 더하는 결정 13), [docs/devops.md](../devops.md) §7.1, [docs/features/notify.md](../features/notify.md) §9·§13, [docs/features/settlement.md](../features/settlement.md) §4.5, [docs/data.md](../data.md) `webhook_endpoint`·`product`·`merch_order_item`, [docs/security/authz-matrix.md](../security/authz-matrix.md) §3.3·§5.3·§7, [docs/review/plans/W12-core-rls2.md](../review/plans/W12-core-rls2.md)
- **관련 ID**: AZ-T18, FR-021, FR-024, FR-025, FR-062, ASVS v5.0.0-8.2.3, ASVS v5.0.0-8.4.1

## 맥락

- core-svc는 DB 역할을 경로마다 나눈다(ADR-0241 결정 1). 팬 경로 역할 `core_app`, 파트너 경로 역할 `core_partner`, 관제 역할 `core_ops`다. 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)과 칸 권한(표 전체가 아니라 칸마다 주는 읽기·고치기 권한)이 쿼리 하나에서 조건이 빠질 때의 두 번째 방어다.
- **웹훅 끝점 `webhook_endpoint`**(파트너가 사건을 받을 주소와 서명 비밀을 적은 표): 0015가 파트너 테넌트 정책을 걸었다. 그런데 0016이 `core_app`에 표 단위 고치기와 조건 없는 고치기 정책 `webhook_endpoint_app_write`(USING `true`, WITH CHECK `true`)를 줬다. `core_app`으로 이 표를 고치는 코드는 웹훅 발송기(사건을 파트너 주소로 서명해 보내는 주기 작업, `services/core-svc/src/main.ts`의 `WebhookWorker`) 하나이고, 하는 일은 계속 실패하는 끝점 끄기(켜짐 → 꺼짐, 사유 `FAILING`, 판 + 1, notify.md §9)뿐이다. 그러나 권한은 모든 파트너 끝점의 주소·비밀·구독·판매자 칸까지 연다. 팬 경로 쿼리 하나가 잘못되면 파트너의 주문 확정·지급 완료 사건이 다른 주소로 가거나, 파트너가 진짜 사건의 서명을 거절하게 된다.
- **굿즈 주문 `merch_order`·`merch_order_item`**: 0016이 `core_partner`에 두 표의 표 단위 넣기·고치기와 테넌트 `FOR ALL` 정책을 줬다. 파트너 코드는 두 표를 쓰지 않는다(배송·반품 처리의 서버 경로가 아직 없다). 상품 정산 원천(`DrizzleMerchOrderStore.listSettlementItems`, `core_app`)은 두 표의 단가(`unit_amount`)·수량·수수료율(`commission_rate_bp`)·환급액·배송비와 주문 상태·결제사·항목 상태·처리 시각 칸으로 정산 항목을 만든다(settlement.md §4.5, ADR-0300 결정 9). 그래서 파트너 경로 쿼리 하나로 자기 테넌트 주문의 정산 값을 바꾸거나, 결제하지 않은 주문을 결제 끝남(`PAID`)으로 넣어 정산에 올릴 수 있다.
- **상품 `product`의 수수료율**: 주문 항목의 수수료율은 주문 때 상품의 `commission_rate_bp`를 복사한 값이다(ADR-0101). 상품 수수료율은 처음 게시할 때 그 판매자의 지금 계약(`promoter_contract`)에서 복사하고 그 뒤 바꾸지 않는다(ADR-0320 결정 6). 그런데 그 값을 적는 쪽이 파트너 코드이고, 0014가 `core_partner`에 상품 표 단위 넣기·고치기를 줬다. 그래서 파트너 경로 쿼리 하나로 자기 상품 수수료율을 아무 값(0 포함)으로 바꾸면, 그 뒤 주문 항목이 그 값을 복사해 정산된다. 수수료율을 바꾸는 정당한 길은 2인 승인 계약 변경(ADR-0320)뿐이어야 한다.

## 결정

1. **웹훅 끝점의 발송기 몫(`core_app`).**
   - 표 단위 고치기를 거두고 `status`·`disabled_reason`·`version` 세 칸의 고치기만 다시 준다. 표 단위 거두기는 같은 종류의 칸 권한도 거두므로 거두기를 먼저 한다.
   - 조건 없는 `webhook_endpoint_app_write`를 지우고 `webhook_endpoint_app_disable`(FOR UPDATE TO `core_app`, USING `status = 'ACTIVE'`, WITH CHECK `status = 'DISABLED' AND disabled_reason = 'FAILING'`)를 둔다. 켜진 끝점을 사유 `FAILING`으로 끄는 것 말고는 고치지 못한다. 꺼진 끝점 다시 켜기, 사유를 `PARTNER`로 적기, 판만 올리기는 거절된다.
   - **행동 바뀜**: 0016까지는 발송기가 이미 꺼진 끝점(파트너가 끈 것, 사유 `PARTNER`)에 끄기를 부르면 사유를 `FAILING`으로 덮고 판을 올렸다. 0042 뒤에는 그 문장이 0행이라 사유 `PARTNER`와 판이 그대로다. 발송기는 끝점을 다시 읽어 꺼졌으면 보내지 않으므로(`dispatcher.ts` 78~83행), 이 경우는 발송기가 읽은 뒤 파트너가 끄는 경쟁 상황에서만 생긴다. 파트너가 끈 뜻이 남으므로 이 쪽이 맞다. 발송기는 0행이어도 끈 것으로 세고 알림 훅을 부른다(118~120행. 지금 알림 훅은 비어 있다).
   - 읽기 몫은 그대로 둔다. 표 단위 읽기(0004의 기본 권한)와 `webhook_endpoint_app_read`(USING `true`)다. 발송기가 모든 파트너의 켜진 끝점을 찾고 주소·지금 비밀·옛 비밀로 서명해야 하기 때문이다. 이 정책을 켜진 끝점으로 좁히면 끄기가 오류로 실패한다. PostgreSQL은 WHERE가 칸을 읽는 UPDATE의 고친 행도 읽기 정책으로 검사하고, 어기면 오류를 낸다(PostgreSQL 18 CREATE POLICY 문서 '명령별 적용 정책' 표).
2. **웹훅 끝점의 파트너 몫(`core_partner`).** 정책 `webhook_endpoint_partner_tenant`(0015, 테넌트 식, ADR-0241 결정 3)는 그대로다. 그래서 파트너는 자기 테넌트 끝점만 읽고 넣고 고친다. 표 단위 고치기를 거두고 코드가 고치는 아홉 칸(`url`·`event_types`·`status`·`disabled_reason`·`secret`·`previous_secret`·`secret_issued_at`·`previous_secret_valid_until`·`version`)만 준다. 끝점 ID와 판매자 칸(`promoter_id`)은 자기 끝점이라도 고치지 못한다(판매자 칸은 정책 WITH CHECK와 두 겹). 읽기·넣기는 그대로다.
3. **굿즈 주문·주문 항목의 파트너 몫(`core_partner`).** 두 표 모두 넣기·고치기를 거두고 칸 권한도 주지 않는다. 지금 파트너 코드가 쓰는 칸이 없다(ADR-0241 결정 4 '권한은 코드가 쓰는 만큼만'). `FOR ALL` 정책 `merch_order_partner_tenant`·`merch_order_item_partner_tenant`를 지우고 읽기 정책 `merch_order_partner_read`·`merch_order_item_partner_read`(FOR SELECT TO `core_partner`, USING 테넌트 식)를 둔다. 읽기는 지금과 같다. 쓰기 정책이 없으므로 뒤에 권한이 잘못 더해져도 쓰기는 0건이다(W12-core-rls가 `promoter`에 읽기·고치기 정책을 나눈 것과 같은 까닭, ADR-0327 결정 13). 팬 경로 역할의 권한과 정책 `merch_order_app_all`·`merch_order_item_app_all`(주문·결제·취소·반품·정산 원천)은 바꾸지 않는다.
4. **상품 수수료율은 계약 값으로만 정해진다(`product`, `core_partner`).**
   - 칸 권한: 파트너 상품 고치기(`DrizzleProductStore.save`)가 SET하는 칸은 상품 표 22칸 가운데 `id`·`promoter_id`를 뺀 스물이다. 표 단위 고치기를 거두고 그 가운데 수수료율을 뺀 열아홉(`type`·`schema_version`·`name`·`status`·`price`·`shipping_fee`·`return_shipping_fee`·`return_address`·`limited_qty`·`transferable`·`ticket_linked`·`linked_event_id`·`fulfillments`·`sale_starts_at`·`sale_ends_at`·`attributes`·`version`·`published_at`·`updated_at`)과, 아래 '두 번에 나눔'의 수수료율 칸을 준다. 상품 ID·판매자 칸은 고치지 못한다. 넣기는 표 단위 그대로다(Drizzle의 넣기는 표 객체의 칸을 모두 적어 칸 단위로 좁힐 수 없다).
   - DB가 수수료율을 정한다: 트리거(행을 넣거나 고치기 직전에 DB가 부르는 함수) `product_commission_from_contract`(BEFORE INSERT OR UPDATE, 행마다)가 파트너 역할이 넣거나 고친 행의 수수료율을 덮어쓴다. 고치기 전 값이 있으면 그 값 그대로(처음 게시 때 고정), 비어 있고 새 상태가 게시(`PUBLISHED`)면 그 판매자의 지금 계약(기간 끝이 열린 `promoter_contract` 행)의 수수료율, 그 밖에는 비움이다. 게시인데 지금 계약이 없으면 오류(23514)로 멈춘다(계약 없는 게시는 실패, ADR-0320 결정 6). 그래서 파트너가 적은 값은 쓰이지 않고, 상품 수수료율이 바뀌는 길은 2인 승인 계약 변경 뒤의 처음 게시뿐이다.
   - 함수는 호출자 권한으로 돈다(정의자 권한이 아니다). 파트너 트랜잭션의 테넌트로 자기 계약만 읽는다(0033 `promoter_contract_partner_read`). `search_path`를 `pg_catalog, pg_temp`로 고정하고 표 이름에 스키마를 붙인다(ADR-0241 결정 5와 같은 까닭). 덮어쓰기는 파트너 역할에게만 돈다. 호출자가 파트너 역할의 구성원(`pg_has_role(current_user, 'core_partner', 'MEMBER')`)이고 슈퍼유저(모든 권한 검사를 넘는 DB 관리 계정)가 아닐 때만 한다(조건 꼴은 0008 `partner_approved_sale_guard`와 같다). 슈퍼유저는 앱 경로가 아니라 뺀다. PostgreSQL 18의 `pg_has_role(…, 'MEMBER')`은 `is_member_of_role`로 보는데, 그 함수는 슈퍼유저를 모든 역할의 구성원으로 본다. 그래서 빼지 않으면 슈퍼유저가 돌리는 마이그레이션·시드·시험 준비의 상품 넣기·고치기에도 트리거가 돈다. 슈퍼유저는 원래 행 보안과 권한을 넘고, 앱 연결은 시작 확인(`assertDatabaseRole`)이 슈퍼유저와 두 역할 겸하기를 막으므로(ADR-0241 결정 7) 파트너 역할의 보호는 같다.
   - 두 번에 나눔: 이전 판 코드는 고치기 문장에 수수료율 칸을 SET한다. 그 칸 권한을 이번에 거두면 배포 창 동안 파트너 상품 고치기가 모두 거절된다(devops.md §7.1 '스키마 변경과 그 변경에 기대는 코드 변경은 같은 배포에 넣지 않는다'). 그래서 0042는 수수료율 칸 고치기 권한을 남기고 트리거로 값을 정한다(그동안 파트너가 적은 값은 덮어쓰인다). 이 묶음의 코드는 SET에서 그 칸을 빼고 DB가 정한 값을 돌려받는다. 그 코드가 배포된 뒤 첫 core-svc 마이그레이션이 `core_partner`의 수수료율 칸 고치기를 거둔다(축소).
   - 팬 경로 역할(주문 때 상품 수수료율을 읽어 복사)과 관제 역할은 바뀌지 않는다.
5. **파트너 쓰기 경로를 만들 때 넘지 않을 선.** 송장 등록·현장 수령·반품 도착 확인·반품 거절(openapi `putPartnerMerchOrderItemShipment`·`createPartnerMerchShipmentImport`·`createPartnerMerchPickup`·`createPartnerMerchOrderItemArrivalConfirmation`·`createPartnerMerchOrderItemArrivalRejection`)의 서버를 만드는 묶음이 그 마이그레이션에서 주문 항목의 칸 고치기와 파트너 고치기 정책을 더한다.
   - 줄 수 있는 칸은 그 전이가 쓰는 항목 상태·송장·처리 시각·거절 사유뿐이다(후보: `status`·`tracking_no`·`shipped_at`·`picked_up_at`·`return_received_at`·`reject_reason`·`return_resolved_at`). 처리 시각은 요청 값이 아니라 서버 시계로 쓴다.
   - 주지 않는 칸: 정산이 읽는 금액·귀속 칸(`unit_amount`·`quantity`·`commission_rate_bp`·`refunded_amount`·`product_id`·`product_name`·`order_id`·`promoter_id`·`event_id`·`ticket_linked`·`event_ends_at`·`fulfillment`·`delivered_at`·`settle_eligible_at`·`statement_id`)과 주문 표 `merch_order`의 모든 칸. 넣기·지우기도 주지 않는다.
   - 고치기 정책은 테넌트 식에 지금 상태 목록(USING)과 새 상태 목록(WITH CHECK)을 함께 건다. 행 보안은 '어느 상태에서 어느 상태로'를 한 식으로 막지 못하므로(USING은 고치기 전 행, WITH CHECK는 고친 뒤 행만 본다), 그 묶음이 앱의 상태 기계와 행 잠금 안 재확인(authz-matrix §3.6)을 함께 둔다.
6. **FORCE 없음.** 네 표 모두 `FORCE ROW LEVEL SECURITY`를 걸지 않는다. 마이그레이션과 시드는 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(ADR-0241 결정 1·6과 '다른 선택지'). `core_ops`·`core_maintenance`·`core_search`는 네 표의 쓰기 권한이 없어 정책을 두지 않는다.
7. **이전 판 코드와 함께 돈다.** 발송기의 끄기 문장(`UPDATE … SET status, disabled_reason, version = version + 1 WHERE id = $1`)은 새 세 칸과 새 정책 안이고, 파트너 웹훅 고치기 문장의 SET 칸은 아홉 칸 안이다. 파트너 상품 고치기 문장은 0042가 남긴 스무 칸 안이고(결정 4 '두 번에 나눔'), 넣기는 표 단위 그대로이며, 적은 수수료율은 트리거가 덮어쓴다. 그래서 배포 창 동안 이전 판도 그대로 돈다.
8. **마이그레이션.** core-svc 0042가 위 1~4를 한다. 정책은 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`, 함수는 `CREATE OR REPLACE FUNCTION`, 트리거는 `DROP TRIGGER IF EXISTS` 뒤 `CREATE TRIGGER`로 다시 돌려도 같게 쓴다(0033·0040 꼴). 시험은 authz-matrix §7 AZ-T18이다.

## 결과

- 팬 경로 쿼리에서 조건이 빠져도 파트너 웹훅의 주소·비밀·구독·판매자는 바뀌지 않고, 파트너가 끈 끝점이 다시 켜지지 않는다.
- 파트너 경로 쿼리에서 조건이 빠져도 다른 파트너의 끝점은 보이지도 바뀌지도 않고, 자기 테넌트 굿즈 주문의 정산 값과 상태도 바뀌지 않는다. 주문을 새로 넣을 수도 없다.
- 상품 수수료율은 파트너가 무엇을 적든 게시 때의 계약 값이고 그 뒤 바뀌지 않는다. 그래서 그 뒤 주문 항목의 수수료율도 계약 값이다.
- 행동 바뀜: 이미 꺼진 끝점에 대한 발송기 끄기는 0행이다(결정 1).
- 시험 준비: 통합 시험의 시드 사용자는 슈퍼유저라 상품 트리거를 건너뛴다(결정 4). 그래서 계약 없이 게시 상품을 넣는 기존 굿즈 통합 시험의 준비가 그대로 돈다. 트리거의 동작은 파트너 역할의 로그인 사용자로 본다(authz-matrix §7 AZ-T18 ⑧).
- 남는 한계:
  - 발송기가 팬 경로 역할로 붙으므로, 그 역할은 여전히 모든 끝점의 주소·비밀을 읽고 켜진 끝점을 `FAILING`으로 끌 수 있다(가용성 위험. 파트너가 다시 켜고 다시 보내기로 되찾는다). notify.md §13의 '발송 워커의 서비스 계정만 비밀을 읽는다'와 아직 다르다. 발송 원장 `webhook_delivery`도 `core_app`에 조건 없는 정책이라 팬 경로 쿼리 하나로 아무 끝점에 꾸민 본문의 발송 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다. 둘은 새 묶음 W12-core-notify(발송기 전용 DB 역할 `core_notify`)가 닫는다(계획 파일 '넘기는 것').
  - 수수료율 칸 고치기 권한은 축소 마이그레이션까지 남는다. 그동안에도 트리거가 값을 정하므로 쓰이는 값은 바뀌지 않는다(결정 4).
  - 파트너 역할은 자기 테넌트 주문의 받는 분 원문을 DB에서 읽을 수 있다. 계약은 가린 값과 접속기록이 남는 보기만 준다(계획 파일 정리 목록 후보).

## 다른 선택지

| 안 | 고르지 않은 까닭 |
| --- | --- |
| 끝점 끄기를 정의자 권한 함수(소유자 권한으로 도는 함수)로만 열고 고치기 권한을 모두 거둔다 | DB가 실패 조건(5일·50건 [가정])까지 볼 수 있지만 도메인 규칙을 SQL로 옮겨 두 곳에 두게 되고, 배포 창 동안 이전 판의 UPDATE 문장이 거절된다. 정책이 '켜진 것을 끄기만'을 코드 변경 없이 준다 |
| 발송기 전용 DB 역할을 이 묶음에서 만든다 | 연결 주소·비밀·배포 값·시작 확인이 늘고 발송 원장까지 옮겨야 범위가 맞는다. 새 묶음 W12-core-notify로 뗐다(감독 결정) |
| 파트너에게 계약의 전이 칸(상태·송장·처리 시각)을 미리 준다 | 코드가 쓰지 않는 권한이다(ADR-0241 결정 4). 행 보안만으로는 반품 요청 항목을 배송 중으로 되돌려 정산에 다시 올리는 길을 막지 못해, 상태 기계를 만드는 묶음이 함께 정해야 한다(결정 5) |
| 상품 수수료율 칸 권한만 거두고 트리거를 두지 않는다 | 넣기는 표 단위라 처음 게시하며 넣는 상품의 수수료율을 막지 못하고, 이전 판 고치기가 배포 창 동안 거절된다 |
| 상품 수수료율을 정의자 권한 함수로 게시 때 채운다 | 함수를 부르는 코드가 늘고, 함수를 부르지 않는 넣기·고치기(이전 판 포함)를 막지 못한다. 트리거는 어느 문장이든 값을 정한다 |
| 트리거를 모든 역할에 건다 | 소유자의 마이그레이션·시드·시험 준비가 계약 없이 게시 상품을 넣어 멈춘다. 앱 역할 가운데 상품을 쓰는 것은 파트너 역할뿐이다 |
| 파트너의 두 주문 표 읽기도 거둔다 | 지금 코드는 읽지 않지만 이 묶음의 위험은 쓰기(돈)이고, 계약의 주문 현황·배송 목록이 곧 읽는다. 받는 분 원문 읽기는 정리 목록 후보로 넘겼다 |
| `FOR ALL` 정책을 그대로 두고 권한만 거둔다 | 넣기·고치기 권한이 실수로 더해지면 행 보안이 막지 못한다(결정 3) |
| `FORCE ROW LEVEL SECURITY` | 마이그레이션·시드가 소유자 권한에 기대어 조용히 0건이 된다(ADR-0241과 같은 까닭) |
