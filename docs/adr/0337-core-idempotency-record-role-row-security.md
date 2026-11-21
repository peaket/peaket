# ADR-0337: core-svc 멱등 기록 표를 역할·작업마다 행 보안으로 나누고, 굿즈 작업의 재생을 지금 요청과 대조한다(2026-11-22)

- **상태**: 채택(2026-11-22, 감독 결정. 방향 '역할마다 자기 작업의 기록만 다룬다. 행 보안으로 묶고 재생 대조도 본다'는 감독이 정했고, 세부는 W12-core-idem 계획 담당의 추천 적용이다. 방향을 바꾸는 결정은 넣지 않았다. 같은 역할 안의 계정 묶기와 결제창 값을 저장하지 않는 재생은 계획 파일 끝의 OPEN 문안으로 감독에게 보냈다)
- **관련**: [ADR-0146](0146-data-retention-gaps-idempotency-records-log-retention.md) 결정 1, [ADR-0241](0241-core-svc-partner-row-security.md) 결정 1·3·4·6·7과 '다른 선택지', [ADR-0300](0300-merch-order-stock-reservation-first-implementation.md) 결정 5·8, [ADR-0315](0315-merch-cancel-return-state-machine.md) 결정 3, [ADR-0316](0316-delayed-refund-account-new-attempt-and-prior-cancel-close.md) 결정 5, [ADR-0320](0320-promoter-contract-terms-approval-and-freeze.md), [docs/api/guidelines.md](../api/guidelines.md) §4, [docs/data.md](../data.md) '서비스마다 둔 멱등 기록 표', [docs/security/authz-matrix.md](../security/authz-matrix.md) §2·§5.3·§7, [docs/review/plans/W12-core-idem.md](../review/plans/W12-core-idem.md)
- **관련 ID**: AZ-T17, FR-021, ASVS v5.0.0-8.2.2, ASVS v5.0.0-8.4.1

## 맥락

- 멱등 기록 표(같은 요청을 다시 보냈을 때 처음 결과를 돌려주려고 키와 결과를 적어 두는 표) `idempotency_record`는 core-svc에 하나다. 처음에는 파트너의 공연 등록·회차 더하기만 썼다. 그래서 ADR-0241 결정 4는 파트너 DB 역할 `core_partner`에 읽기·넣기·고치기를 주면서 '값은 만든 ID뿐이다'라고 적었다.
- 그 뒤 0027이 팬 굿즈 작업 일곱을 더하며 팬 경로 역할 `core_app`에 읽기·넣기·고치기를, 0033이 관제 파트너사 작업 둘을 더하며 관제 역할 `core_ops`에 지우기까지 주었다. 행 보안(RLS: 표의 행마다 누가 보고 고칠 수 있는지 DB가 거르는 규칙)은 없다. 그래서 세 역할이 모든 작업의 기록을 읽고 고칠 수 있다.
- 결과 참조(`result_ref`)에는 이제 응답 본문이 든다. 굿즈 결제 시도는 결제창 값 JSON(결제사 공개 키·구매자 키·금액·결제 뒤 돌아올 주소)을 통째로 적고, 재생 때 그 글을 그대로 돌려준다. 파트너 경로나 관제 경로의 쿼리 하나에서 조건이 빠지면 팬의 결제창 값을 읽거나 바꿀 수 있고, `created_at`을 고치거나 행을 지우면 같은 키의 재시도가 다시 처리되어 주문·결제 시도가 두 번 생길 수 있다.
- 다른 서비스의 같은 꼴 표에는 행 보안이 없다. DB 역할을 나눈 서비스는 core-svc와 ops-svc뿐이고, ops-svc는 파트너 역할에 읽기·넣기만 준다(고치기·지우기 없음, authz-matrix §5.3 'ops-svc 구현'). 나머지 서비스는 앱 역할이 하나라 역할 사이 문제가 없다.

## 결정

1. **작업과 역할의 짝.** 작업 하나는 한 역할만 쓴다. 표의 작업 CHECK 목록(`idempotency_record_operation_check`)의 모든 값이 아래 세 줄 가운데 꼭 한 줄에 든다.

   | DB 역할 | 작업(`operation`) | 쓰는 곳 |
   | --- | --- | --- |
   | `core_partner` | `CREATE_PRODUCTION`, `CREATE_PRODUCTION_EVENT` | 파트너 공연 등록·회차 더하기(테넌트를 건 파트너 트랜잭션) |
   | `core_app` | `CREATE_MERCH_ORDER`, `START_MERCH_PAYMENT`, `ACCEPT_MERCH_PAYMENT`, `CREATE_TICKET_ADDON`, `CANCEL_MERCH_ORDER`, `RETURN_MERCH_ORDER`, `SHOP_CANCEL_REFUND_ACCOUNT` | 팬 굿즈 주문·부가 상품 주문·결제 시도·결제 접수·취소·반품·환급 계좌 다시 받기 |
   | `core_ops` | `CREATE_OPS_PROMOTER`, `CREATE_OPS_PROMOTER_CONTRACT_CHANGE` | 관제 파트너사 등록·계약 조건 변경 요청 |

   - 새 작업을 더하는 마이그레이션은 CHECK 목록과 함께 그 역할의 정책 셋(또는 넷)의 작업 목록도 고친다. 빠뜨리면 그 작업의 첫 요청이 거절(42501)되어 통합 시험에서 드러난다.

2. **파트너 기록의 테넌트 칸.** 0041이 `tenant_id uuid` 칸을 더한다. 기본값은 `nullif(current_setting('app.tenant_id', true), '')::uuid`다. 파트너 트랜잭션은 첫 문장에서 테넌트를 걸므로(authz-matrix §5.3) 그 트랜잭션에서 넣은 행에 그 테넌트가 저절로 들고, 다른 역할의 행은 비어 있다(NULL). 앱은 이 칸을 적지 않는다(아래 4의 넣기 권한에 없다).
   - 0041은 이미 있는 파트너 기록을 결과 참조로 채운다. 공연 등록은 `productionId`의 공연 판매자, 회차 더하기는 `eventId`의 회차 판매자, 아직 회차 행이 없는 변경분 회차는 그 `eventId`를 `pending_revision.addedEvents`에 가진 공연의 판매자다. JSON이 아닌 결과 참조는 건너뛴다(마이그레이션이 변환 오류로 멈추지 않게).
   - 그래도 못 채운 행은 비어 있는 채로 둔다. 그 행은 어느 파트너에게도 보이지 않고, 보관 기간(24시간 [가정])이 지나면 정비가 지운다(아래 결과의 남는 한계).

3. **행 보안과 정책.** 0041이 `idempotency_record`에 행 보안을 켜고 정책 열 개를 둔다. 아래 '작업 목록'은 결정 1의 그 역할 줄이고, '테넌트 식'은 `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`(ADR-0241 결정 3과 같은 식)다.

   | 정책 | 역할 | 명령 | USING(어느 기존 행에 닿는가) | WITH CHECK(넣거나 고친 행이 지킬 조건) |
   | --- | --- | --- | --- | --- |
   | `idempotency_record_partner_read` | `core_partner` | SELECT | 작업 목록 안 그리고 테넌트 식 | — |
   | `idempotency_record_partner_insert` | `core_partner` | INSERT | — | 작업 목록 안 그리고 테넌트 식 |
   | `idempotency_record_partner_update` | `core_partner` | UPDATE | 작업 목록 안 그리고 테넌트 식 | 같은 식 |
   | `idempotency_record_app_read` | `core_app` | SELECT | 작업 목록 안 | — |
   | `idempotency_record_app_insert` | `core_app` | INSERT | — | 작업 목록 안 |
   | `idempotency_record_app_update` | `core_app` | UPDATE | 작업 목록 안 | 같은 식 |
   | `idempotency_record_ops_read` | `core_ops` | SELECT | 작업 목록 안 | — |
   | `idempotency_record_ops_insert` | `core_ops` | INSERT | — | 작업 목록 안 |
   | `idempotency_record_ops_update` | `core_ops` | UPDATE | 작업 목록 안 | 같은 식 |
   | `idempotency_record_ops_delete` | `core_ops` | DELETE | 작업 목록 안 | — |

   - 명령마다 정책을 나눈다. 정책이 없는 명령은 행 보안이 기본으로 거부하므로, 뒤에 권한이 잘못 더해져도 그 명령은 0건이다(ADR-0327 결정 13과 같은 까닭).
   - 팬·관제 역할의 정책은 테넌트를 보지 않는다. 그 기록은 테넌트가 아니라 계정이 범위다(guidelines §4 '범위'). 관제 계약 변경 요청은 계정 대신 작업 범위 `ops-contract-change`를 쓴다(docs/data.md).
   - `FORCE ROW LEVEL SECURITY`는 걸지 않는다. 마이그레이션·백필과 정비 연결은 표 소유자로 돌고, 앱 역할은 표 소유자가 아니다(ADR-0241 결정 1·6과 '다른 선택지').
   - `core_maintenance`·`core_search`는 이 표의 권한이 없어 정책을 두지 않는다. 권한을 줄 일이 생기면 그 마이그레이션이 정책도 더한다.

4. **칸 권한.** 세 역할의 표 단위 넣기·고치기를 거두고 칸 단위로 다시 준다.
   - 넣기: `account_ref`·`operation`·`idempotency_key`·`request_hash`·`result_ref`·`created_at` 여섯 칸(플랫폼 `IdempotencyStore`가 적는 칸). `tenant_id`는 넣지 못한다(기본값만 든다).
   - 고치기: `request_hash`·`result_ref`·`created_at` 세 칸(보관 기간이 지난 키를 다시 잡을 때와 결과를 채울 때 고치는 칸). 범위 칸(`account_ref`·`operation`·`idempotency_key`)과 `tenant_id`는 고치지 못한다. 그래서 기록을 남의 계정·다른 작업·다른 키로 옮길 수 없다.
   - 읽기는 지금처럼 표 단위이고, 지우기는 지금처럼 `core_ops`에만 있다(계약 변경 요청을 풀 때 그 기록을 지운다).
   - 표 단위 REVOKE는 같은 종류의 칸 권한도 거두므로 거두기를 먼저 하고 칸 권한을 뒤에 준다.

5. **이전 판 코드와 함께 돈다.** 쿼리와 칸 이름을 바꾸지 않는다. 배포 창 동안 이전 판도 같은 플랫폼 문장(같은 여섯 칸 넣기, 같은 세 칸 고치기)을 쓰고, 파트너 트랜잭션은 이미 테넌트를 건다. 그래서 0041 뒤에도 이전 판이 그대로 돈다.

6. **굿즈 작업의 재생 대조(앱 층).** core-svc shop은 결정 1의 `core_app` 작업 일곱의 기록을 다시 돌려주기 전에, 결과 참조가 지금 요청의 계정과 경로의 주문에 속하는지 본다. 같은 키 동시 요청이 트랜잭션 안에서 받는 재생도 같다.

   | 작업 | 결과 참조 | 대조 |
   | --- | --- | --- |
   | `CREATE_MERCH_ORDER`, `CREATE_TICKET_ADDON` | 주문 ID | 그 주문의 계정이 세션 계정이다 |
   | `START_MERCH_PAYMENT` | 처음 응답(결제창 값) JSON | JSON을 읽을 수 있고, 시도 ID가 경로 주문의 시도이며 그 주문의 계정이 세션 계정이고, 결제사가 그 시도의 결제사이고, 결제창 금액(토스 `amount`, 포트원 `totalAmount`)이 주문 금액이다 |
   | `ACCEPT_MERCH_PAYMENT` | `accepted` 또는 `sold-out` | 두 값 가운데 하나이고, 경로 주문의 계정이 세션 계정이다 |
   | `CANCEL_MERCH_ORDER`, `SHOP_CANCEL_REFUND_ACCOUNT` | `cancel:{취소 ID}` | 그 취소 행의 주문이 경로 주문이고 그 주문의 계정이 세션 계정이다 |
   | `RETURN_MERCH_ORDER` | `return:{주문 ID}` | 그 주문 ID가 경로 주문이다(읽기는 지금처럼 세션 계정으로 한다) |

   - 맞지 않으면 처음 응답 대신 남의 주문과 같은 404 `not-found`로 답한다(authz-matrix §2의 4 '없는 것처럼 답한다'. 반품 재생이 모양이 틀린 참조에 이미 그렇게 답한다). 그 요청은 DB에 쓰지 않고 결제사를 부르지 않는다.
   - 보안 이벤트로 오류 로그 한 줄을 남긴다(authz-matrix §2의 7): `kind` `idempotency-replay-mismatch`, `severity` `SEV2`, `operation`, 경로의 주문 ID. 계정 ID와 결과 참조 원문은 싣지 않는다.
   - 대조는 처음 응답 뒤에도 바뀌지 않는 사실만 본다(소유 계정, 시도가 속한 주문, 시도의 결제사, 주문 금액). 시도가 그 뒤 대체·만료되었어도 처음 응답을 돌려준다(guidelines §4 '돌려주는 응답').
   - 파트너·관제 작업의 재생은 대조하지 않는다. 파트너 기록은 결정 3의 테넌트 식이 다른 파트너를 막고, 관제 역할은 모든 파트너사를 본다.

7. **서비스 시작 확인은 바꾸지 않는다.** 앱 역할이 표 소유자가 아니고 역할을 겸하지 않는지는 지금 확인(ADR-0241 결정 7)이 본다. AZ-T17이 이 표의 소유자와 FORCE 여부를 본다.

## 결과

- 어느 경로의 쿼리에서 조건이 빠져도 다른 역할 작업의 기록은 보이지도 바뀌지도 지워지지도 않는다. 파트너 기록은 다른 파트너에게 보이지 않는다.
- 앱 역할은 기록을 다른 계정·작업·키로 옮기지 못한다.
- 팬 굿즈 작업은 기록이 다른 주문·다른 계정을 가리키거나 결제창 금액이 주문과 다르면 그 값을 돌려주지 않는다.
- 남는 한계:
  - 같은 역할 안의 다른 계정 기록(팬끼리, 같은 테넌트의 파트너 계정끼리)은 DB가 가르지 않는다. 계정 값을 트랜잭션에 걸어 묶으려면 이전 판 코드가 그 값을 걸지 않아 배포 창 동안 막히므로, 두 번에 나눠 내야 한다(OPEN 문안).
  - 팬 경로의 잘못된 쿼리가 결제창 값 가운데 core가 확인할 수 없는 칸(결제사 공개 키, 돌아올 주소의 출처, 주문명)을 바꾸면 재생 대조가 잡지 못한다. 결제창 값을 저장하지 않고 재생 때 다시 만드는 길(guidelines §4 '예외 둘째'와 같은 꼴)은 OPEN 문안이다.
  - 0041 전에 쓴 파트너 기록 가운데 결과 참조로 판매자를 찾지 못한 행은 그 파트너의 재시도에도 보이지 않는다(결정 2). 그 키의 재시도는 처음 응답을 받지 못하고(보관 기간 안에는 처리 중 409, 그 뒤에는 거절), 정비가 그 행을 지운 뒤에야 새 요청으로 처리된다. 배포 직전 24시간 [가정] 안에 낸 변경분 회차 요청을 같은 키로 다시 보낼 때만 생긴다.

## 다른 선택지

| 안 | 고르지 않은 까닭 |
| --- | --- |
| 역할마다 표를 나눈다(플랫폼 `IdempotencyStore`의 표 이름 설정) | 표마다 권한만 주면 되지만, 배포 창 동안 이전 판은 옛 표, 새 판은 새 표에 적어 같은 키의 재시도가 다른 표를 보고 두 번 처리된다. 옮기기·정비 지우기도 표마다 늘어난다 |
| `account_ref`에 테넌트를 붙인다(`{테넌트}:{계정}`) | 키 모양이 바뀌어 배포 창의 재시도가 처음 기록을 찾지 못한다. 범위 규칙(guidelines §4 '계정 × 작업')과도 어긋난다 |
| 계정 값을 트랜잭션에 걸어 모든 역할을 계정마다 묶는다 | 가장 좁지만 이전 판 코드가 그 값을 걸지 않아 0041과 같이 내면 배포 창 동안 멱등 쓰기가 모두 거절된다. 두 번에 나눠 내는 안은 OPEN 문안으로 넘겼다 |
| `FOR ALL` 정책 하나씩 | 넣기·지우기 권한이 실수로 더해지면 행 보안이 막지 못한다(결정 3) |
| `FORCE ROW LEVEL SECURITY` | 백필과 정비 지우기가 소유자 권한에 기대어 조용히 0건이 된다(ADR-0241과 같은 까닭) |
| 결과 참조에 서버 키로 만든 서명을 붙여 재생 때 검사한다 | DB 안의 모든 변조를 잡지만 새 비밀 키와 그 교체·배포가 모든 서비스에 든다. 이 묶음의 위험(역할 사이)은 행 보안으로 막힌다 |
| 재생이 맞지 않으면 500 | 이유를 알릴 것이 없고, 남의 자원은 없는 것처럼 답하는 규칙(authz-matrix §2의 4)과 반품 재생의 지금 답(404)에 맞춘다 |
