# ADR-0327: 파트너 판매 승인 요청·승인 뒤 판매 열기·대기열 세대 writer(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 결정. 갈래 5 BAT-616 담당이 LCH-080 잔여의 정본 빈칸으로 정했다. 판매 승인 자체의 규칙은 [ADR-0093](0093-production-entity-place-artist-units.md)·[ADR-0062](0062-open-items-delegated-decisions.md)·[ADR-0122](0122-event-sale-status-all-held-sold-out-reopen.md)·[ADR-0181](0181-queue-failover-pause-numbers-until-rb05.md)·[ADR-0186](0186-rb05-resume-after-replication-confirm.md)·[ADR-0200](0200-event-detail-public-contract.md)·[ADR-0260](0260-production-layout-copy-price-tiers-fan-seatmap-file.md)·[ADR-0320](0320-promoter-contract-terms-approval-and-freeze.md) 그대로이고, 이 ADR은 그 사이의 저장 모양·차례·경계를 정한다)
  - 보충(2026-11-22, 감독 결정 W12-core-rls, 보안 높음): 결정 13을 더했다. 0034가 판매자 표를 파트너 DB 역할에 행 보안 없이 열어, 다른 파트너의 판매자 행까지 읽고 고칠 수 있었다.
  - 보충(2026-11-22, 갈래 5 BAT-617): 결정 14를 더했다. 판매 승인 화면을 열면서 승인 본문·상세 읽기 칸을 구현과 계약에 맞췄고, 메모리 저장소를 DB와 같게 맞췄다.
- **관련**: [docs/data.md](../data.md) `production`·`promoter`·`event_sale`·`seat_rebuild`·`q:{event:E}:cfg`·`q:{event:E}:epoch`, [docs/features/settlement.md](../features/settlement.md) §3·§9·§10, [docs/features/seat-hold.md](../features/seat-hold.md) §4·§6·§12, [docs/features/control-tower.md](../features/control-tower.md) §4, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/partner/productions/{productionId}/sale-review`·`/v1/ops/sale-reviews*`, [docs/api/guidelines.md](../api/guidelines.md) §1·§3·§8.1, [docs/security/authz-matrix.md](../security/authz-matrix.md) §3.3·§4.1·§5.3, [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §2.14·§2.15, [docs/review/plans/BAT-616.md](../review/plans/BAT-616.md), [docs/review/plans/W12-core-rls.md](../review/plans/W12-core-rls.md)
- **관련 ID**: S-T41, LCH-080, FR-052, POL-037, AZ-T5, BUILD_ORDER BAT-616

## 맥락

- LCH-080은 R-528이 관제 승인·반려, pending 규칙·회차 고침·규모 적용, `event_sale_config`와 `q:{event:E}:cfg` 쓰기, 정비 일 `sale-config-publish`까지만 했다. 파트너 판매 승인 요청, SCR-048·SCR-021 화면, `openSale`·`q:epoch`·`event_sale` UPCOMING, CDN 무효화, 5분·30분 간격은 없다.
- `POST/DELETE /v1/partner/productions/{productionId}/sale-review`는 openapi에만 있고 core-svc에 처리기가 없어 404다. `production`에 요청 시각·반려 사유 칸이 없고, `RejectSaleReview`는 사유를 받고 버린다.
- `ApproveSaleReview`는 승인 커밋 뒤 `PublishSaleConfigs`만 부르고 purchase-svc 판매 열기·CDN 무효화를 하지 않는다. API 조립의 `SALE_CONFIG_STORE`는 DB 하나라(`catalog.module.ts`) 승인 직후 대기열 사본이 서지 않고, relay 정비 일이 하루 한 번 쓴다. `QueueSaleConfigStore.put`은 `rev`를 비교하지 않고 `q:epoch`도 쓰지 않는다.
- purchase-svc에는 `openSale`·`markOpened`가 있지만 운영 호출자가 시드뿐이고, `event_sale`의 UPCOMING 행을 만드는 길이 없다. 오픈 전에 행이 없으면 판정 첫 틱이 ON_SALE 행을 만든다.
- 지급대행 등록(예금주 일치·토스페이먼츠 셀러·포트원 파트너)은 payment-svc 지급대행 어댑터와 LCH-110 몫이다. settlement §3은 그 등록을 판매 승인 완료 조건으로 적지만, 이 묶음에는 어댑터가 없다.
- 좌석맵 대기 판 공개 이동은 ADR-0260 결정 9가 정했지만, purchase-svc의 좌석맵 출처가 아직 `PEAKET_SEATMAP_DIR`의 정적 파일이고 운영 S3 어댑터는 HOT-200 전이다. 승인이 대기 판을 옮겨도 purchase가 읽을 길이 없다.

## 결정

1. **판매 승인 요청은 파트너 관리자만 하고, 요청 자체가 판매자 정보를 쓴다.**
   - `POST /v1/partner/productions/{productionId}/sale-review`는 `partner_admin`만 부른다(`partner_member` 403). DRAFT·REJECTED·APPROVED에서 SUBMITTED로 가고, 이미 SUBMITTED면 같은 202다. SUSPENDED는 409다.
   - 본문은 닫힌 객체다. 판매자 6칸(상호·대표자·주소·전화·이메일·사업자등록번호)과 통신판매업 신고번호 또는 면제 근거 가운데 하나, 정산 계좌 모양, 휠체어석 확인 참을 받는다. 회차가 0개이거나 등록 공연장·새 공연장 요청이 없으면 422다.
   - 요청 트랜잭션은 `promoter`에 판매자 정보를 쓰고, `production`을 SUBMITTED·`sale_submitted_at`=지금·`rejection_reason` NULL·`accessible_seating_check`=참으로 쓴다. `promoter.verified_at`(운영자 확인 시각)은 바꾸지 않는다.
   - 정산 계좌는 모양만 보고 **저장하지 않는다**. 계좌번호 전체·은행·끝 4자리를 이 묶음의 표에 남기지 않는다(LCH-110 전).
2. **변경 취소는 승인 이력이 있을 때만 마지막 승인 내용으로 돌린다.**
   - `DELETE`는 승인 이력이 있고 SUBMITTED·REJECTED일 때만 204다. `pending_revision`·`eventChanges`를 비우고 APPROVED로 돌아가며 `sale_submitted_at`·`rejection_reason`도 비운다. 그 밖은 409 `sale-review-not-cancellable`이다.
3. **반려 사유를 저장한다.**
   - 반려는 사유 1~1,000자 필수이고 `production.rejection_reason`에 남긴다. `sale_review`가 REJECTED가 아니면 NULL이라는 CHECK를 둔다. 승인·새 요청·변경 취소가 사유를 비운다. 공개본·재승인 대기 변경분은 고치지 않는다. 파트너 현황과 관제 상세가 같은 사유를 읽는다.
4. **관제 목록·상세는 읽기 경로를 둘 더한다.**
   - `GET /v1/ops/sale-reviews`는 상태(기본 SUBMITTED, 쉼표 목록)·커서·limit을 받고 제출·승인·등록 시각 오래된 순으로 준다. viewer·CS도 읽는다. 목록에는 계좌번호 전체·연락처·사업자번호를 싣지 않는다.
   - `GET /v1/ops/sale-reviews/{productionId}`는 확인 패널용이다. 공연·파트너 상호·판매자 정보·회차(오픈·시작·규모)·판매 정책 읽기 전용·제출 시각·재승인 여부·반려 사유를 준다. viewer·CS도 읽고 없으면 404다. 두 응답 모두 `no-store`다.
   - `GET /v1/partner/productions/{productionId}/sale-review`는 파트너 5단계용이다. 상태·반려 사유·승인 이력·제출 시각·판매자 정보·회차 요약을 주고 계좌번호 전체는 싣지 않는다. 관리자·실무자 모두 읽는다.
5. **승인 커밋 뒤에 판매를 연다. 판매 열기의 소유자는 purchase-svc다.**
   - core-svc는 승인 커밋 뒤 비취소 회차마다 시작 시각 오름차순으로 purchase-svc 내부 `POST /internal/v1/events/{eventId}/sale-open`을 부른다(내부 토큰, 시간 상한 3초 [가정]). core-svc가 purchase 좌석 Redis를 직접 만지지 않는다.
   - purchase는 ① `event_sale` UPCOMING 행(`status='UPCOMING'`, `version=1`, `previous_status` 비움, `open_at`, `sellable_seats`, `available=sellable_seats`, `held=0`, `paying=0`, `sold_out_tiers` 빈 배열, 같은 트랜잭션 Outbox `EventSaleChanged(UPCOMING)`) ② `seat_rebuild` 판 번호 1 표시 ③ `openSale`(비트맵·세대 키·`s:ctl:events`)를 차례로 한다. 같은 회차를 다시 불러도 행·판·비트맵을 새로 만들지 않는다.
   - 좌석맵 판이 없거나 판매 종료(공연 시작 24시간 전)가 지났으면 409 `sale-not-publishable`이고 행을 만들지 않는다. 취소 회차는 core-svc가 부르지 않는다.
6. **판매 열기가 성공한 뒤에만 대기열 사본을 쓴다. 실패하면 닫힌 채로 남긴다.**
   - 승인·정비 일은 열기 결과가 `opened`·`exists`인 회차와, 이미 판매가 끝난 회차의 정산 원천 사본만 `event_sale_config`·`q:{event:E}:cfg`에 쓴다. `no-layout`·`error`·`unwired`인 회차는 쓰지 않아 대기열이 404(닫힘)이고, 정비 일 `sale-config-publish`가 다음 날 다시 시도한다.
   - 열기·사본·CDN 무효화의 실패는 승인 응답을 바꾸지 않는다(승인은 200). 로그·지표만 남긴다.
7. **`q:cfg` writer는 `rev`가 클 때만 쓰고, `q:epoch`의 node를 처음 한 번 쓴다.**
   - API 조립도 core DB+대기열 합성 저장소(`CompositeSaleConfigStore`)를 쓴다. `QueueSaleConfigStore.put`은 Lua 하나로 `rev`를 `tonumber`로 비교해 새 rev가 더 클 때만 값·수명을 쓰고, `q:{event:E}:epoch`의 `node`가 없을 때만 지금 노드 표지(`{CLUSTER MYID}:{cluster_my_epoch}`, 단일 노드는 `standalone`)를 쓴다. 같은 rev·낮은 rev는 아무것도 바꾸지 않는다.
   - 두 키의 수명은 판매 종료 + 1일(= 공연 시작)이고 `q:{admission}:events` 점수도 시작 시각이다.
8. **CDN 태그를 무효화한다.**
   - 승인 커밋 뒤 회차마다 `event:{eventId}`와 공연 `production:{productionId}` 태그를 무효화한다(ADR-0200 결정 5). 실패는 로그만 남긴다. 반려는 공개본이 바뀌지 않아 부르지 않는다.
9. **지급대행 등록 없이 승인을 허용하고 "연동 전"으로 표시한다.**
   - 이 묶음은 계좌 모양만 검사하고 승인을 막지 않는다. 관제 상세·파트너 화면은 "지급대행 연동 전"이라고 적고 가짜 등록 상태를 만들지 않는다. 실제 등록·예금주·KYC는 LCH-110이 닫는다. settlement §3에 그 한계를 적는다.
10. **좌석맵 대기 판 공개 이동은 범위 밖이다.**
    - 승인은 대기 판을 옮기지 않는다. purchase가 좌석맵을 못 읽으면 열기가 409로 닫히고 로그·지표만 남는다. 이동은 HOT-200·후속이다(ADR-0260 결정 9).
11. **표·마이그레이션.**
    - `production.sale_submitted_at timestamptz`·`production.rejection_reason text`를 core 0034에서 더한다. 반려 사유 1~1,000자 CHECK와 REJECTED에서만 있다는 CHECK를 둔다.
    - `core_partner`는 판매자 정보 칸과 요청이 쓰는 공연 칸(`sale_review`·`sale_submitted_at`·`rejection_reason`·`accessible_seating_check`)만 UPDATE한다. `core_ops`는 반려 사유·제출 시각을 더 쓴다. `promoter.verified_at`은 어느 쪽도 이 경로에서 쓰지 않는다.
12. **화면은 BAT-617로 넘긴다.**
    - 이 묶음은 서버·저장소·대기열·purchase까지다. SCR-048 목록·확인 패널·승인·반려와 SCR-021 5단계 연결은 BAT-617이 하고, LCH-080은 그때 끝으로 체크한다.
13. **판매자 표(`promoter`)에도 행 보안을 건다. 파트너는 자기 판매자 행만 읽고 고친다(보충 2026-11-22, 감독 결정 W12-core-rls).**
    - 까닭: 결정 1·11대로 요청이 판매자 정보를 쓰고 파트너 현황이 그 값을 읽으려면 `core_partner`에게 `promoter`를 열어야 한다. 0034는 표 전체 읽기를 주면서 행 보안(RLS: 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)을 걸지 않았다. 그래서 파트너 DB 역할이 다른 파트너의 판매자 행(연락처·사업자번호)까지 읽고 고칠 수 있었다(AZ-T5, CI 실행 44919441525).
    - core 0040이 `promoter`에 행 보안을 켠다. 이 표의 테넌트 값은 `promoter.id` 자체다(다른 테넌트 표의 `promoter_id`와 같은 값, [authz-matrix](../security/authz-matrix.md) §3.3).
    - `core_partner` 정책은 둘이다. 읽기 `promoter_partner_self_read`(FOR SELECT)와 고치기 `promoter_partner_self_update`(FOR UPDATE, USING과 WITH CHECK 둘 다)이고, 조건은 `id = nullif(current_setting('app.tenant_id', true), '')::uuid` 하나다([ADR-0241](0241-core-svc-partner-row-security.md) 결정 3과 같은 식). 넣기·지우기 정책은 두지 않는다(권한도 없다).
    - `core_partner`의 읽기 권한은 표 단위에서 칸 단위로 좁힌다. `id`와 결정 11의 판매자 정보 칸(0034가 고치기를 준 8칸)만 읽는다. `verified_at`·`commission_rate_bp`·`pending_contract_approval_id`는 자기 행이라도 읽지 않는다. 계약 값은 `promoter_contract`로 읽는다([ADR-0320](0320-promoter-contract-terms-approval-and-freeze.md) 결정 8).
    - `core_ops`는 조건 없는 정책 `promoter_ops`(FOR ALL)를 둔다. ADR-0320 결정 8의 '두 표에 조건 없는 정책'을 이 표에도 채운다. `core_app`은 읽기만 전체인 `promoter_app_read`(FOR SELECT)를 둔다. 회차 상세가 모든 판매자의 신원정보를 싣기 때문이다([ADR-0200](0200-event-detail-public-contract.md), POL-037). 쓰기 정책은 없다.
    - `core_maintenance`·`core_search`는 이 표의 권한이 없어 정책을 두지 않는다. 정책이 없으면 행 보안이 0건으로 답한다. 권한을 줄 일이 생기면 그 마이그레이션이 정책도 더한다.
    - `FORCE ROW LEVEL SECURITY`는 걸지 않는다. 마이그레이션과 부트스트랩 시드는 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(ADR-0241 결정 1과 '다른 선택지'). AZ-T5가 소유자와 FORCE 여부를 본다.
    - 이 결정으로 ADR-0241 결정 4의 '판매자 연락처를 읽지 못한다'는 '다른 파트너의 판매자 행을 읽지 못한다'로 좁혀진다.

14. **판매 승인 화면은 승인 본문을 `scales`·`placeId`(선택)·`accessibleSeatingCheck`(선택)로 좁힌다. 아티스트·다른 이름 연결은 LCH-080 잔여다(보충 2026-11-22, BAT-617).**
    - `POST /v1/ops/sale-reviews/{productionId}/approvals` 본문에서 `artistIds`(필수)·`aliases`를 뺀다. 구현 `SaleApprovalBody`가 `.strict()`로 두 칸을 받지 않고 저장 코드도 없어, 계약을 지키는 생성 클라이언트 본문이 400이 되던 어긋남을 없앤다(RV-05).
    - 화면은 상세가 준 `placeId`가 있으면 그 값을 싣고, 없으면(새 공연장 요청) 보내지 않아 서버가 지금 값을 그대로 둔다. 관제 상세는 `placeId`·`placeName`·`requestedPlace`·`accessibleSeatingCheck`를, 파트너 현황은 `title`을 더한다. 관제 상세가 등록 공연장 이름을 읽도록 core 0044이 `core_ops`에 `place`의 `id`·`name`만 연다.
    - 운영자가 기존 아티스트·공연장을 잇거나 새로 만드는 경로(`POST /v1/ops/artists`·`POST /v1/ops/places`)와 `production_artist`·`search_alias` 쓰기는 이 묶음에 넣지 않는다. 화면은 읽기 전용 안내만 두고 LCH-080 단계 줄은 체크하지 않는다.
    - 메모리 저장소는 관제 상세의 취소 회차 포함과 목록 정렬 폴백(`created_at`)을 DB와 같게 맞춘다(RV-06).

## 결과

- 파트너가 판매 승인을 요청하고 변경을 거둘 수 있으며, 관제가 목록·상세에서 사유와 함께 승인·반려한다.
- 승인 직후 purchase가 회차를 열고(UPCOMING 행·`seat_rebuild` 판 1·세대 키) core가 `q:cfg`·`q:epoch`를 써서 대기열과 구매가 같은 시점에 열린다. 열기가 실패하면 대기열은 닫힌 채로 남고 정비 일이 다시 연다.
- `rev`가 낮은 늦은 쓰기가 새 사본을 덮지 않고, `q:epoch`의 node가 장애 전환을 드러낸다.
- 파트너 경로의 쿼리에서 테넌트 조건이 빠져도 다른 파트너의 판매자 행은 나오지도 바뀌지도 않는다(결정 13).
- 남는 한계: 지급대행 등록·예금주·KYC는 LCH-110 전이다. 좌석맵 대기 판 이동·승인 전 `published_version` 검사는 HOT-200·후속이다. 승인 때 5분·대형 30분 간격, 휠체어석 수·위치 재계산, 결제사 지정 고정은 LCH-090이다. 화면은 BAT-617이다.

## 다른 선택지

| 길 | 고르지 않은 까닭 |
| --- | --- |
| core-svc가 purchase 좌석 Redis를 직접 연다 | 좌석 수·판 파일·세대 키를 가진 쪽이 purchase라, 두 곳이 같은 Lua·같은 규칙을 복제하게 된다. 열기의 소유자가 흐려진다 |
| 승인이 `event_sale` UPCOMING 행을 직접 만든다 | 회차 좌석 수·판 번호·세대를 모르는 core가 purchase 표를 쓰면 판과 행이 어긋난다 |
| 열기가 실패해도 `q:cfg`를 써서 대기열을 먼저 연다 | 구매자가 들어오고 좌석은 NOT_READY 503이 된다. 닫힌 쪽이 낫다(seat-hold §6) |
| `rev`를 글자로 비교한다 | 9→10에서 '10' < '9'라 늦은 낮은 rev가 새 사본을 덮는다. Lua `tonumber`로 비교한다 |
| `q:epoch`의 node를 늘 `standalone`으로 쓴다 | 장애 전환을 알아채지 못해 RB-05가 건너뛸 번호를 잘못 잡는다(ADR-0181) |
| 지급대행 등록 전에는 승인을 멈춘다 | LCH-110 전까지 판매 승인이 전부 막혀 이 묶음의 목적이 사라진다. 등록은 화면에 "연동 전"으로 남기고 LCH-110이 닫는다 |
| 반려 사유를 응답에만 싣고 저장하지 않는다 | 파트너가 다시 볼 때 사유가 사라지고, 관제 상세·감사에서도 근거가 없다 |
| 화면까지 이 묶음에 넣는다 | 서버·시험·정본이 이미 3일을 넘는다. 감독이 BAT-617로 나눴다 |
| (결정 13) 파트너에게 `promoter`를 열지 않고 판매자 정보 읽기·쓰기를 정의자 권한 함수로 한다 | 함수는 소유자 권한으로 돌아 행 보안을 지난다. 함수 안의 조건 하나가 2차 방어 전부가 되고, 요청·현황 저장소를 다시 짜야 한다 |
| (결정 13) 파트너 정책을 `FOR ALL` 하나로 둔다 | 넣기·지우기 권한이 실수로 더해지면 행 보안이 막지 못한다. 읽기·고치기 둘로 나누면 정책이 없는 명령은 기본으로 거부된다 |
| (결정 13) `FORCE ROW LEVEL SECURITY`를 건다 | ADR-0241과 같은 까닭이다. 마이그레이션 백필과 부트스트랩 시드가 소유자 권한에 기대어 조용히 0건이 된다 |
