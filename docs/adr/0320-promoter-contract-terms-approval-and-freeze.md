# ADR-0320: 파트너 계약 조건(수수료율·보증)의 저장·2인 승인·판매 승인 때 고정(2026-11-20)

- **상태**: 채택(2026-11-20, 추천 적용. 갈래 5 BAT-615 계획 담당이 LCH-070의 정본 빈칸으로 정했다. 방향은 [ADR-0060](0060-screen-blueprint-open-decisions.md) 결정 9(수수료율·보증 변경은 operator 요청·commander 승인, 바뀐 값은 승인 뒤 판매 승인을 받는 공연부터 쓰고 판매 승인 때 공연에 고정)와 [ADR-0086](0086-query-index-rules-plan-diagnostics-data-pattern-gaps.md)(승인 자식 표·유일 제약) 그대로이고, 그 안의 저장 모양과 이 묶음의 경계를 정한다)
- **관련**: [docs/data.md](../data.md) `promoter`·`promoter_contract`·`event`·`approval_request`·`approval_vote`·§5, [docs/features/settlement.md](../features/settlement.md) §3·§4.1·§4.5·§9·§10·§13, [docs/features/control-tower.md](../features/control-tower.md) §4, [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §2.10·§3·POL-038 ⑨, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/ops/promoters*`·`ApprovalRequest.contractTerms`, [docs/security/asvs/settlement.md](../security/asvs/settlement.md), [docs/security/authz-matrix.md](../security/authz-matrix.md) §4.1, [docs/review/plans/BAT-615.md](../review/plans/BAT-615.md)
- **관련 ID**: J-T29·J-T30 제안, FR-052·FR-062, POL-038 ⑨, BUILD_ORDER LCH-070·BAT-615

## 맥락

- SCR-065 파트너사·계약 관리 화면과 openapi의 `/v1/ops/promoters*`는 2026-11-09 ADR-0238이 초안만 더했다. core-svc에는 `promoter`의 공개 신원정보만 있고, `promoter_contract` 표·`promoter.commission_rate_bp`·`event.commission_rate_bp`가 없다. data.md에는 칸과 표가 있지만 코드·마이그레이션이 없다.
- 판매 승인은 `EventSaleConfig`를 만들어 `event_sale_config`와 대기열 `q:{event:E}:cfg`에 쓰지만, `commissionRateBp`를 채우지 않는다. payment-svc 회차 정산은 이 값을 읽어 계산하고, 없으면 503 `event-commission-rate-unavailable`로 닫는다(A1-H10). 그래서 지금은 판매 승인된 회차의 정산서를 만들 수 없다.
- 상품 수수료율은 `product.commission_rate_bp`에 처음 게시할 때 복사하지만, 운영 조립이 `FixedCommissionRate(1000bp)`라 실제 계약 값을 쓰지 않는다.
- BUILD_ORDER는 LCH-070을 GAT-290·GAT-300(2인 승인)과 지급대행 어댑터 뒤로 보류했다. 그러나 GAT-290은 아직 시작 전이고, GAT-300은 예외 환불·양도 회수·미성년자 계약 취소라 계약 조건 변경과 무관하다. GAT-290을 통째로 기다리면 LCH-070은 계속 멈춘다.
- 결제사 지급대행 등록(토스페이먼츠 셀러·포트원 파트너·예금주 조회)은 payment-svc 지급대행 어댑터와 LCH-110이 필요하다. SCR-065 결제사 등록 탭은 실제 값이 없다.

## 결정

1. **계약 조건은 파트너사마다 기간으로 남긴다.**
   - `promoter_contract`에 `commission_rate_bp`·`guarantee_rate_bp`·`guarantee_kind`·`valid_during`(기간)·`approval_id`를 둔다. 지금 계약은 상한이 없는 기간 하나이고, 변경은 옛 기간의 끝과 새 기간의 시작을 같은 시각으로 맞춰 덧붙인다. 옛 기간은 고치지 않는다.
   - PostgreSQL 18의 `UNIQUE (promoter_id, valid_during WITHOUT OVERLAPS)`와 `btree_gist`로 기간이 겹치지 않게 한다. `promoter.commission_rate_bp`는 지금 계약 값의 사본으로 두고, 계약 적용 트랜잭션에서 함께 고친다.
   - `event.commission_rate_bp`는 판매 승인 때 고정한 값이다. `promoter.pending_contract_approval_id`는 열린 계약 변경 승인 업무를 가리키며, 목록·상세의 승인 대기 표시에 쓴다.
2. **첫 계약은 승인 없이, 변경만 2인 승인이다.**
   - `POST /v1/ops/promoters`가 상호와 첫 계약(수수료율·보증 비율·보증 종류)을 함께 받아 `promoter`와 `promoter_contract`를 한 트랜잭션으로 만든다. 첫 계약의 `approval_id`는 null이다.
   - 이후 변경은 `POST /v1/ops/promoters/{promoterId}/contract-term-changes`가 `CONTRACT_TERMS_CHANGE` 승인 업무를 만든다. operator·commander가 요청하고, 요청자가 아닌 commander가 `act=APPROVAL` 재인증 뒤 승인한다(POL-038 ⑨). 요청에는 재인증을 받지 않는다.
   - 한 파트너에 열린(`PENDING_APPROVAL`·`EXECUTING`·`FAILED`) 변경은 하나다. core의 `pending_contract_approval_id`와 ops의 부분 유일 인덱스가 두 겹으로 막는다.
3. **승인 업무는 GAT-290 전체가 아니라 `CONTRACT_TERMS_CHANGE` 한 종류만 먼저 만든다.**
   - data.md의 `approval_request`·`approval_vote`를 쓰고, 계약에만 필요한 지금 값·요청 값은 `promoter_contract_change`에 둔다. ops-svc의 기존 `payout_approval`은 그대로 두고, 승인 경로는 kind로 나누는 `ApprovalRouter`가 맡는다.
   - 1인·2인 기준 일반화, 증빙 확인만, 철회·만료 작업, 상위 승인 알림, 다른 승인 종류는 GAT-290에 남긴다. 이 ADR은 그 단계가 이 모양을 일반화할 수 있다고 본다.
   - 승인 적용은 core-svc가 같은 승인 ID로 멱등하게 한다. 적용이 실패하면 승인은 `FAILED`로 남고, 원인을 고친 뒤 같은 승인 ID로 다시 실행한다(ADR-0073).
4. **판매 승인 때 수수료율을 고정한다.**
   - 판매 승인 트랜잭션 안에서 그 파트너의 지금 계약 수수료율을 읽는다. 첫 승인이면 그 공연의 모든 회차 `event.commission_rate_bp`에 쓴다. 재승인이면 이미 승인된 회차의 값은 바꾸지 않고, 새로 더한 회차만 그때의 값으로 쓴다.
   - `EventSaleConfig.commissionRateBp`와 `event_sale_config.payload`, 대기열 `q:{event:E}:cfg`의 `config` JSON에 같은 값을 싣는다. payment-svc는 이 값으로 회차 정산을 계산한다.
   - 계약이 없는 파트너의 판매 승인은 수수료율을 비워 두고, payment-svc 정산이 503으로 닫는 쪽을 유지한다. 임의의 10%를 만들지 않는다.
5. **기존 파트너는 마이그레이션에서 한 번만 채운다.**
   - `promoter_contract`가 없는 기존 `promoter` 행마다 `1000bp`·`1000bp`·`DEPOSIT` [가정]의 첫 계약을 넣고 `promoter.commission_rate_bp`를 채운다. data.md의 "계약 표가 없어 지금은 기본 1000bp"를 데이터로 굳히는 한 번의 이전이다. 새 파트너는 등록 때 명시 값을 받는다.
6. **상품 수수료율의 원천을 계약 표로 바꾼다.**
   - core-svc shop의 `CommissionRateSource`를 `promoter_contract`의 지금 수수료율을 읽는 어댑터로 바꾼다. 상품을 처음 게시할 때만 `product.commission_rate_bp`에 복사하고, 이미 게시된 상품은 계약이 바뀌어도 값을 바꾸지 않는다. 주문 항목은 주문 때 값을 복사한다(ADR-0101).
   - 이 읽기는 파트너 경로의 테넌트 트랜잭션(`app.tenant_id`) 안에서 한다. `promoter_contract`에 `core_partner`의 읽기 권한과 행 보안 정책을 둔다.
7. **결제사 등록·지급 계좌·KYC는 이 결정의 범위 밖이다.**
   - SCR-065 결제사 등록 탭은 실제 연동 전이다. `payoutAccount`는 null, `pgRegistration`은 빈 목록·`portonePartnerRegistered: false`로 답하고 화면에 "지급대행 연동 전"이라고 적는다. 가짜 셀러·계좌 상태를 만들지 않는다.
   - data.md `promoter`의 토스 셀러·포트원 파트너·정산 계좌 칸은 payment-svc `payout_account`·`seller_kyc`와 중복이다. 이 ADR은 payment-svc 표를 정본으로 두고 core `promoter`에 복제하지 않는다. data.md의 중복 칸은 다음에 고칠 때 payment-svc 소유로 정리한다.
8. **DB 역할과 행 보안.**
   - 관제 경로(core-svc `/v1/ops/promoters*`)는 `core_ops` 풀로 접속한다. `core_ops`에 `promoter`·`promoter_contract` 읽기·쓰기와 `event.commission_rate_bp` UPDATE를 주고, 두 표에 조건 없는 정책을 둔다.
   - 파트너 경로의 상품 게시는 `core_partner`로 `promoter_contract`를 읽는다. `promoter_id = app.tenant_id` 정책을 둔다. 팬 경로(`core_app`)에서는 계약 표를 회수한다.
9. **관측과 감사.**
   - 계약 변경 요청·승인·반려·철회·적용은 ops 감사 체인에 남긴다. 파트너 ID·바뀐 칸·승인 ID·행위자를 남기고 계좌번호·결제사 내부 ID는 넣지 않는다.
   - 계약 없이 승인된 회차를 세는 `sale_config_commission_missing_total`, 계약 변경 결과 `contract_change_requests_total{result}`, 상품 수수료율 원천 결과 `shop_commission_source_total{result}`를 둔다.

## 결과

- SCR-065 계약 탭과 SCR-046 계약 승인 카드가 실제 API로 동작하고, 판매 승인된 회차의 정산서를 payment-svc가 계산할 수 있다.
- 계약 조건 변경은 2인 승인과 기간 이력으로 남고, 이미 판매 승인된 공연의 수수료율은 바뀌지 않는다.
- GAT-290 전체를 기다리지 않고 계약 한 종류만 먼저 열므로, GAT-290이 일반화할 때 `approval_request`·`approval_vote` 모양을 이어 쓸 수 있다.
- 남는 한계: 결제사 등록·지급 계좌·KYC·보증 징수는 실제 연동 전이다. 계약 없는 기존 파트너는 백필 값(1000bp)을 쓴다. `approval_request`와 `payout_approval` 두 승인 저장 모양이 GAT-290 전까지 공존한다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| GAT-290이 끝날 때까지 LCH-070을 계속 보류한다 | GAT-290은 아직 시작 전이고, 계약 변경 한 종류를 위해 전체 승인 틀을 기다리면 화면·정산 입력이 계속 막힌다. 좁은 한 종류는 같은 data.md 표로 나중에 일반화할 수 있다 |
| `payout_approval` 표에 계약 변경을 얹는다 | 지급 묶음 전용 칸(batch_id·pg·payout_date)이 NOT NULL이라 계약에 맞지 않고, 감사·재시도 의미도 다르다 |
| 계약 조건을 `promoter` 한 줄로만 두고 이력을 남기지 않는다 | 바뀐 수수료율의 적용 시점과 이미 승인된 공연의 고정 값을 가릴 수 없다. 정산 분쟁에서 근거가 사라진다 |
| 계약이 없으면 기본 1000bp로 판매 승인한다 | 임의의 10%를 파트너 계약으로 굳힌다. A1-H10이 정한 닫힌 쪽(정산 503)과 어긋난다 |
| SCR-065 결제사 등록 탭에 가짜 상태를 채운다 | 실제 연동 전 값과 화면이 다르고, 운영자가 등록된 것으로 오해한다 |