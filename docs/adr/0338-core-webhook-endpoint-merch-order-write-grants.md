# ADR-0338: core-svc 웹훅 끝점과 굿즈 주문의 앱 역할 쓰기 권한을 칸과 상태로 좁힌다(2026-11-22)

- **상태**: 채택(2026-11-22, 감독 결정. 방향 '팬 경로 역할의 웹훅 끝점 표 단위 고치기와 조건 없는 정책을 거두고, 파트너는 자기 테넌트 끝점만 고치며, 발송기 몫은 따로 둔다. 파트너의 굿즈 주문 표 단위 고치기를 거두고 단가·수수료율은 파트너가 고치지 못하게 한다'는 감독이 정했고, 세부는 W12-core-rls2 계획 담당의 추천 적용이다. 방향을 바꾸는 결정은 넣지 않았다. 발송기 전용 DB 역할은 계획 파일 끝의 OPEN 문안으로 감독에게 보냈다)
- **관련**: [ADR-0241](0241-core-svc-partner-row-security.md) 결정 1·3·4·6·7과 '다른 선택지', [ADR-0053](0053-crypto-hardening-pseudonyms-webhooks-stores-runbook-audit.md) 결정 4, [ADR-0109](0109-delivery-jobs-in-postgres-drop-bullmq-cache-redis-key-classes-noeviction.md), [ADR-0101](0101-product-catalog-postgres-jsonb-drop-mongodb.md), [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md) 결정 9, [ADR-0327](0327-sale-review-request-and-sale-open.md)(W12-core-rls가 더하는 결정 13), [docs/features/notify.md](../features/notify.md) §9·§13, [docs/features/settlement.md](../features/settlement.md) §4.5, [docs/data.md](../data.md) `webhook_endpoint`·`merch_order_item`, [docs/security/authz-matrix.md](../security/authz-matrix.md) §3.3·§5.3·§7, [docs/review/plans/W12-core-rls2.md](../review/plans/W12-core-rls2.md)
- **관련 ID**: AZ-T18, FR-021, FR-024, FR-025, FR-062, ASVS v5.0.0-8.2.3, ASVS v5.0.0-8.4.1

## 맥락

- core-svc는 DB 역할을 경로마다 나눈다(ADR-0241 결정 1). 팬 경로 역할 `core_app`, 파트너 경로 역할 `core_partner`, 관제 역할 `core_ops`다. 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)과 칸 권한(표 전체가 아니라 칸마다 주는 읽기·고치기 권한)이 쿼리 하나에서 조건이 빠질 때의 두 번째 방어다.
- **웹훅 끝점 `webhook_endpoint`**(파트너가 사건을 받을 주소와 서명 비밀을 적은 표): 0015가 파트너 테넌트 정책을 걸었다. 그런데 0016이 `core_app`에 표 단위 고치기와 조건 없는 고치기 정책 `webhook_endpoint_app_write`(USING `true`, WITH CHECK `true`)를 줬다. `core_app`으로 이 표를 고치는 코드는 웹훅 발송기(사건을 파트너 주소로 서명해 보내는 주기 작업, `services/core-svc/src/main.ts`의 `WebhookWorker`) 하나이고, 하는 일은 계속 실패하는 끝점 끄기(켜짐 → 꺼짐, 사유 `FAILING`, 판 + 1, notify.md §9)뿐이다. 그러나 권한은 모든 파트너 끝점의 주소·비밀·구독·판매자 칸까지 연다. 팬 경로 쿼리 하나가 잘못되면 파트너의 주문 확정·지급 완료 사건이 다른 주소로 가거나, 파트너가 진짜 사건의 서명을 거절하게 된다.
- **굿즈 주문 `merch_order`·`merch_order_item`**: 0016이 `core_partner`에 두 표의 표 단위 넣기·고치기와 테넌트 `FOR ALL` 정책을 줬다. 파트너 코드는 두 표를 쓰지 않는다(배송·반품 처리의 서버 경로가 아직 없다). 상품 정산 원천(`DrizzleMerchOrderStore.listSettlementItems`, `core_app`)은 두 표의 단가(`unit_amount`)·수량·수수료율(`commission_rate_bp`)·환급액·배송비와 주문 상태·결제사·항목 상태·처리 시각 칸으로 정산 항목을 만든다(settlement.md §4.5, ADR-0300 결정 9). 그래서 파트너 경로 쿼리 하나로 자기 테넌트 주문의 정산 값을 바꾸거나, 결제하지 않은 주문을 결제 끝남(`PAID`)으로 넣어 정산에 올릴 수 있다.

## 결정

1. **웹훅 끝점의 발송기 몫(`core_app`).**
   - 표 단위 고치기를 거두고 `status`·`disabled_reason`·`version` 세 칸의 고치기만 다시 준다. 표 단위 거두기는 같은 종류의 칸 권한도 거두므로 거두기를 먼저 한다.
   - 조건 없는 `webhook_endpoint_app_write`를 지우고 `webhook_endpoint_app_disable`(FOR UPDATE TO `core_app`, USING `status = 'ACTIVE'`, WITH CHECK `status = 'DISABLED' AND disabled_reason = 'FAILING'`)를 둔다. 켜진 끝점을 사유 `FAILING`으로 끄는 것 말고는 고치지 못한다. 꺼진 끝점 다시 켜기, 사유를 `PARTNER`로 적기, 판만 올리기는 거절된다. 이미 꺼진 끝점(파트너가 끈 것)은 0행이라 사유가 바뀌지 않는다.
   - 읽기 몫은 그대로 둔다. 표 단위 읽기(0004의 기본 권한)와 `webhook_endpoint_app_read`(USING `true`)다. 발송기가 모든 파트너의 켜진 끝점을 찾고 주소·지금 비밀·옛 비밀로 서명해야 하기 때문이다. 이 정책을 켜진 끝점으로 좁히면 끄기가 오류로 실패한다. PostgreSQL은 WHERE가 칸을 읽는 UPDATE의 고친 행도 읽기 정책으로 검사하고, 어기면 오류를 낸다(PostgreSQL 18 CREATE POLICY 문서 '명령별 적용 정책' 표).
2. **웹훅 끝점의 파트너 몫(`core_partner`).** 정책 `webhook_endpoint_partner_tenant`(0015, 테넌트 식, ADR-0241 결정 3)는 그대로다. 그래서 파트너는 자기 테넌트 끝점만 읽고 넣고 고친다. 표 단위 고치기를 거두고 코드가 고치는 아홉 칸(`url`·`event_types`·`status`·`disabled_reason`·`secret`·`previous_secret`·`secret_issued_at`·`previous_secret_valid_until`·`version`)만 준다. 끝점 ID와 판매자 칸(`promoter_id`)은 자기 끝점이라도 고치지 못한다(판매자 칸은 정책 WITH CHECK와 두 겹). 읽기·넣기는 그대로다.
3. **굿즈 주문·주문 항목의 파트너 몫(`core_partner`).** 두 표 모두 넣기·고치기를 거두고 칸 권한도 주지 않는다. 지금 파트너 코드가 쓰는 칸이 없다(ADR-0241 결정 4 '권한은 코드가 쓰는 만큼만'). `FOR ALL` 정책 `merch_order_partner_tenant`·`merch_order_item_partner_tenant`를 지우고 읽기 정책 `merch_order_partner_read`·`merch_order_item_partner_read`(FOR SELECT TO `core_partner`, USING 테넌트 식)를 둔다. 읽기는 지금과 같다. 쓰기 정책이 없으므로 뒤에 권한이 잘못 더해져도 쓰기는 0건이다(W12-core-rls가 `promoter`에 읽기·고치기 정책을 나눈 것과 같은 까닭, ADR-0327 결정 13). 팬 경로 역할의 권한과 정책 `merch_order_app_all`·`merch_order_item_app_all`(주문·결제·취소·반품·정산 원천)은 바꾸지 않는다.
4. **파트너 쓰기 경로를 만들 때 넘지 않을 선.** 송장 등록·현장 수령·반품 도착 확인·반품 거절(openapi `putPartnerMerchOrderItemShipment`·`createPartnerMerchShipmentImport`·`createPartnerMerchPickup`·`createPartnerMerchOrderItemArrivalConfirmation`·`createPartnerMerchOrderItemArrivalRejection`)의 서버를 만드는 묶음이 그 마이그레이션에서 주문 항목의 칸 고치기와 파트너 고치기 정책을 더한다.
   - 줄 수 있는 칸은 그 전이가 쓰는 항목 상태·송장·처리 시각·거절 사유뿐이다(후보: `status`·`tracking_no`·`shipped_at`·`picked_up_at`·`return_received_at`·`reject_reason`·`return_resolved_at`). 처리 시각은 요청 값이 아니라 서버 시계로 쓴다.
   - 주지 않는 칸: 정산이 읽는 금액·귀속 칸(`unit_amount`·`quantity`·`commission_rate_bp`·`refunded_amount`·`product_id`·`product_name`·`order_id`·`promoter_id`·`event_id`·`ticket_linked`·`event_ends_at`·`fulfillment`·`delivered_at`·`settle_eligible_at`·`statement_id`)과 주문 표 `merch_order`의 모든 칸. 넣기·지우기도 주지 않는다.
   - 고치기 정책은 테넌트 식에 지금 상태 목록(USING)과 새 상태 목록(WITH CHECK)을 함께 건다. 행 보안은 '어느 상태에서 어느 상태로'를 한 식으로 막지 못하므로(USING은 고치기 전 행, WITH CHECK는 고친 뒤 행만 본다), 그 묶음이 앱의 상태 기계와 행 잠금 안 재확인(authz-matrix §3.6)을 함께 둔다.
5. **FORCE 없음.** 세 표 모두 `FORCE ROW LEVEL SECURITY`를 걸지 않는다. 마이그레이션과 시드는 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(ADR-0241 결정 1·6과 '다른 선택지'). `core_ops`·`core_maintenance`·`core_search`는 세 표의 권한이 없어 정책을 두지 않는다.
6. **이전 판 코드와 함께 돈다.** 코드·쿼리를 바꾸지 않는다. 발송기의 끄기 문장(`UPDATE … SET status, disabled_reason, version = version + 1 WHERE id = $1`)은 새 세 칸과 새 정책 안이고, 파트너 웹훅 고치기 문장의 SET 칸은 아홉 칸 안이다. 그래서 배포 창 동안 이전 판도 그대로 돈다.
7. **마이그레이션.** core-svc 0042가 위 1~3을 한다. 정책은 `DROP POLICY IF EXISTS` 뒤 `CREATE POLICY`로 다시 돌려도 같게 쓴다(0033·0040 꼴). 시험은 authz-matrix §7 AZ-T18이다.

## 결과

- 팬 경로 쿼리에서 조건이 빠져도 파트너 웹훅의 주소·비밀·구독·판매자는 바뀌지 않고, 파트너가 끈 끝점이 다시 켜지지 않는다.
- 파트너 경로 쿼리에서 조건이 빠져도 다른 파트너의 끝점은 보이지도 바뀌지도 않고, 자기 테넌트 굿즈 주문의 정산 값과 상태도 바뀌지 않는다. 주문을 새로 넣을 수도 없다.
- 남는 한계:
  - 발송기가 팬 경로 역할로 붙으므로, 그 역할은 여전히 모든 끝점의 주소·비밀을 읽고 켜진 끝점을 `FAILING`으로 끌 수 있다(가용성 위험. 파트너가 다시 켜고 다시 보내기로 되찾는다). notify.md §13의 '발송 워커의 서비스 계정만 비밀을 읽는다'와 아직 다르다. 발송 원장 `webhook_delivery`도 `core_app`에 조건 없는 정책이라 팬 경로 쿼리 하나로 아무 끝점에 꾸민 본문의 발송 행을 넣으면 발송기가 그 파트너 비밀로 서명해 보낸다. 발송기 전용 DB 역할이 둘을 함께 닫는다(계획 파일의 OPEN 문안).
  - 파트너 역할은 상품 표 `product`의 수수료율 칸을 고칠 수 있다(0014 표 단위 고치기). 주문 항목은 주문 때 그 값을 복사하므로, 이 결정은 이미 만든 주문 항목의 값만 지킨다(계획 파일 끝 목록의 높음 후보).
  - 파트너 역할은 자기 테넌트 주문의 받는 분 원문을 DB에서 읽을 수 있다. 계약은 가린 값과 접속기록이 남는 보기만 준다(계획 파일 끝 목록).

## 다른 선택지

| 안 | 고르지 않은 까닭 |
| --- | --- |
| 끝점 끄기를 정의자 권한 함수(소유자 권한으로 도는 함수)로만 열고 고치기 권한을 모두 거둔다 | DB가 실패 조건(5일·50건 [가정])까지 볼 수 있지만 도메인 규칙을 SQL로 옮겨 두 곳에 두게 되고, 배포 창 동안 이전 판의 UPDATE 문장이 거절된다. 정책이 '켜진 것을 끄기만'을 코드 변경 없이 준다 |
| 발송기 전용 DB 역할을 지금 만든다 | 연결 주소·비밀·배포 값·시작 확인이 늘고, 발송 원장까지 옮겨야 범위가 맞는다. 방향을 넓히는 일이라 OPEN 문안으로 넘겼다 |
| 파트너에게 계약의 전이 칸(상태·송장·처리 시각)을 미리 준다 | 코드가 쓰지 않는 권한이다(ADR-0241 결정 4). 행 보안만으로는 반품 요청 항목을 배송 중으로 되돌려 정산에 다시 올리는 길을 막지 못해, 상태 기계를 만드는 묶음이 함께 정해야 한다(결정 4) |
| 파트너의 두 표 읽기도 거둔다 | 지금 코드는 읽지 않지만 이 묶음의 위험은 쓰기(돈)이고, 계약의 주문 현황·배송 목록이 곧 읽는다. 받는 분 원문 읽기는 계획 끝 목록으로 넘겼다 |
| `FOR ALL` 정책을 그대로 두고 권한만 거둔다 | 넣기·고치기 권한이 실수로 더해지면 행 보안이 막지 못한다(결정 3) |
| `FORCE ROW LEVEL SECURITY` | 마이그레이션·시드가 소유자 권한에 기대어 조용히 0건이 된다(ADR-0241과 같은 까닭) |
