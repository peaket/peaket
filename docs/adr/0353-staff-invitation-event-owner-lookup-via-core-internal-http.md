# ADR-0353: 파트너 현장 스태프 초대의 회차 판매자 대조는 core-svc 내부 HTTP로 한다(2026-11-22)

- **상태**: 채택(2026-11-22, 추천 적용, BUILD_ORDER BAT-450B 계획). `docs/api/proto/README.md` §4의 '현장 스태프 배정의 파트너 대조(identity-svc → ?)' 미해결을 닫는다.
- **관련**: [ADR-0285](0285-mesh-port-allow-source-generated-policies.md) 결정 9(REST 포트의 내부 HTTP 부르는 쪽), [ADR-0051](0051-offline-gate-admission-scanner-session.md), [ADR-0081](0081-partner-api-path-and-operation-conventions.md), [ADR-0172](0172-admin-role-tenant-request-time-decision.md), docs/features/identity.md §6.1, docs/security/authz-matrix.md §3.4·AZ-T2·AZ-T3, docs/api/proto/README.md §4, docs/api/guidelines.md §8.1
- **관련 ID**: FR-046, POL-031, I-T21, I-T86

## 맥락

- 파트너 콘솔은 회차 단위로 현장 스태프를 초대한다(`POST /v1/partner/events/{eventId}/staff-invitations`). 초대를 만들려면 그 회차가 요청한 파트너의 것인지 확인해야 하고(AZ-T3), 배정의 유효 시작·끝을 회차 시각으로 정해야 한다(docs/data.md `staff_assignment`: 입장 시작 3시간 전 ~ 공연 종료 2시간 뒤).
- 회차·판매자(`event.promoter_id`)는 core 데이터이고 identity-svc는 core DB를 직접 읽지 않는다(ADR-0007). identity-svc에는 이 확인을 부르는 길이 없었다(docs/api/proto/README.md §4, open-items 78번).
- core-svc에는 이미 읽기 전용 내부 HTTP `GET /internal/v1/events/{eventId}/sale-config`가 있다. 판매 승인 때 만든 사본이고 `promoterId`·`startsAtMs`·`endsAtMs`·`entryOpensAtMs`를 준다. purchase-svc(BAT-051)·ticket-svc·ops-svc가 같은 경로를 쓰고, 서비스 사이 공유 토큰(`x-peaket-internal-token`, 없거나 틀리면 401)으로 좁힌다.
- `docs/architecture.md` §3.2는 내부 동기 호출에 gRPC를 쓰고, 이 읽기 전용 경로 하나만 REST 예외로 둔다. 그 뒤 일괄 환불·정산·CS 처리함·운영 경보·공개키 묶음 같은 내부 HTTP가 더해졌고, 메시 포트 허용 정책이 쓰는 부르는 쪽 목록은 ADR-0285 결정 9가 관리한다.
- 판매 설정 사본은 판매 승인 때 생긴다. 그래서 승인 전 회차나 없는 회차는 404다. 초대를 승인 전에도 만들지는 이 ADR이 정하지 않고, 지금은 승인된 회차만 허용한다.

## 결정

1. **identity-svc는 core-svc의 기존 읽기 전용 내부 HTTP `GET /internal/v1/events/{eventId}/sale-config`를 부른다.** 새 core gRPC 서비스를 만들지 않는다. 응답에서 `promoterId`·`startsAtMs`·`endsAtMs`·`entryOpensAtMs`(선택)만 읽는다. 한 번의 읽기라 proto·생성물·서버를 새로 만드는 비용이 이득보다 크다.
2. **부르는 쪽 목록에 더한다.** ADR-0285 결정 9의 REST 표에 `identity-svc → core-svc`(판매 설정 사본, 스태프 초대의 회차 소유 확인) 줄을 보충하고, `deploy/platform/mesh/port-allow.yaml`의 core-svc REST `callers`에 `identity-svc`를 더한 뒤 생성 파일(`policies.yaml`·`meshless-networkpolicies.yaml`)을 `node tools/ci/mesh-policies.mjs --write`로 다시 만든다. docs/architecture.md §3.2 REST 행의 내부 HTTP 예외 목록에도 이 호출을 적는다.
3. **내부 토큰**: `PEAKET_INTERNAL_TOKEN`을 `x-peaket-internal-token` 머리로 보낸다. local·ci는 값이 비어도 core의 `InternalTokenGuard`가 검사를 끄므로 그대로 동작한다. 운영에서 core가 토큰을 요구하는데 identity에 값이 없으면 401이고, 초대 만들기는 아래 4의 503으로 닫힌다. 배포 단계는 identity-svc의 Secret에 `PEAKET_INTERNAL_TOKEN`을 더한다(이 묶음은 값 파일에 비밀을 두지 않는다).
4. **오류 매핑**:
   - 404(없는 회차·판매 승인 전·다른 파트너 회차) → 파트너 경로는 **404 `not-found`**다. 세 경우의 본문이 같아 존재 여부를 흘리지 않는다(AZ-T2·AZ-T3).
   - 401·403·5xx·시간 초과(5초 [가정])·연결 실패·응답 모양 틀림 → **503 `authz-unavailable`**(Retry-After)이다. 초대 행을 만들지 않는다(닫힌 쪽).
   - local·ci에서 주소(`PEAKET_CORE_HTTP_URL`)나 어댑터가 없을 때도 같은 503이다.
5. **테넌트는 요청 본문이 아니라 세션에서만 온다.** `principal.tenantId`(ADR-0172, identity `GetAdminAuthz`가 채운다)와 core가 준 `promoterId`를 견준다. 본문·경로의 `promoterId`는 받지 않는다. 배정의 `promoter_id`는 core가 준 값으로 채운다(C2-10의 생성 경로).
6. **판매 승인 전 회차는 이 묶음에서 초대할 수 없다.** `event_sale_config`가 없으면 404다. 승인 전 초대가 필요해지면 core에 회차 소유만 보는 별도 읽기를 더하는 새 ADR로 넓힌다.
7. **메일 전달은 동기 발송이 아니라 포트 + local·ci 파일 대역까지다.** `StaffInviteMailer` 포트를 두고 `PEAKET_STAFF_MAIL_DIR`의 파일 대역만 만든다. 운영 대행사 어댑터는 GAT-250/BAT-455로 넘긴다. 메일 포트가 없으면 초대 만들기·재발송은 503 `provider-down`이고 행을 만들지 않는다(보내지 못한 초대를 만든 척하지 않는다).
8. **초대 토큰은 32바이트 CSPRNG, SHA-256만 저장, 24시간, 1회용**이고 링크의 URL 조각(`#token=`)에만 둔다. API 응답·헤더·로그·감사에 원문을 싣지 않는다. 재발송은 해시를 새 토큰으로 바꿔 옛 토큰을 즉시 무효로 한다. 같은 회차·같은 이메일의 INVITED 중복은 애플리케이션 검사와 부분 유일 인덱스(마이그레이션 0036) 두 곳에서 막는다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| core-svc에 업무 gRPC `EventSaleConfigService`를 새로 두고 identity-svc가 부른다 | 기각. gRPC 규칙에는 맞지만 같은 값을 proto·생성물·서버로 한 번 더 옮겨 적고, 한 번의 읽기라 이득이 작다. method 단위 메시 정책을 새로 만들 부담도 있다 |
| identity-svc가 core DB를 직접 읽는다 | 기각. 서비스마다 DB 경계를 나눈 규칙(ADR-0007)과 행 보안·역할 분리를 깬다 |
| 초대 만들 때 core에 쓰기(초대 사본)를 둔다 | 기각. core는 회차·판매자 원본이고 스태프 배정 원본은 identity다. 같은 사실을 두 곳에 두면 해제·만료 정비가 갈라진다 |
| 메일을 Outbox 행 + 재시도로 보낸다 | 이 묶음에서는 기각. 대행사가 없어 재시도할 어댑터도 없다. 포트와 파일 대역으로 계약만 고정하고, 운영 대행사·발송 원장은 GAT-250/BAT-455가 정한다 |

## 결과와 트레이드오프

- **좋은 점**: 이미 있는 읽기 전용 경로와 공유 토큰을 그대로 써서 계약·배포·시험의 새 표면이 작다. 회차 소유 확인과 유효 시간 계산이 한 응답에서 온다. 파트너 콘솔 그림(gw-partner → identity-svc, docs/architecture.md §3.3)과 라우트가 맞는다.
- **남는 한계**: 내부 동기 호출의 REST 예외가 하나 더 늘어난다(ADR-0285 결정 9가 목록을 관리한다). 판매 승인 전 회차는 초대할 수 없다. 운영 메일 대행사가 없어 운영 초대는 503이다(의도한 닫힘). `PEAKET_INTERNAL_TOKEN`을 identity Secret에 더하는 배포 작업은 이 묶음 밖이다. 응답의 `endsAtMs`가 없는 옛 사본은 503으로 닫는다.

## 되돌릴 조건

- 파트너 콘솔이 판매 승인 전 회차에도 초대해야 한다면, core에 회차 소유·시각만 주는 읽기를 더하는 새 ADR로 넓힌다.
- 내부 HTTP를 경로로 거를 필요가 커지거나(ADR-0285 '되돌릴 조건') identity→core 호출이 늘어나면 core gRPC로 옮기는 안을 다시 본다.
- 운영 메일 대행사가 정해지면 `StaffInviteMailer` 어댑터와 발송 원장을 BAT-455가 더한다. 그때 이 ADR의 '동기 포트' 결정은 그대로 두고 어댑터만 바꾼다.

## 확인

- `services/identity-svc/test/http-core-event-owners.test.ts`(I-T86 ②), `services/identity-svc/test/partner-staff-invitations.test.ts`(I-T86 ③), `services/core-svc/test/internal-sale-config-identity-caller.test.ts`(I-T86 ①), `tools/ci/bat450b-contract.test.mjs`가 이 결정을 본다.
- `node tools/ci/mesh-policies.mjs --check`와 `node tools/ci/gateway-routes.mjs --check`가 부르는 쪽·라우트를 본다.
- 계획·검증 기록은 `docs/review/plans/BAT-450B.md`다.
