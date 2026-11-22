# BAT-450B 계획·기록 — 파트너 초대 서버(GAT-210)

- 묶음: BAT-450B, 갈래 3, 구간 3, 등급 B(권한·개인정보·보안 통제). 단계 `GAT-210`(wbs 5.5.1) 가운데 **서버 몫**만. WBS 일 2.5 [가정].
- 장부 범위: `I-T21, I-T86`. 2026-11-22 `ledger --scope` 실측에서 I-T21은 세부 번호가 없고 I-T86은 없다. **I-T40대는 모두 다른 기능이 차지하고 있어 새 번호는 I-T86부터 쓴다**(I-T40 부스 본인확인 대조, I-T41~I-T46 자동 시험, I-T47 URL 조각은 GAT-230, I-T48~I-T85 다른 기능).
- 기준: `origin/develop` `c338f446a`. 작업 폴더 `D:/ticketpass-lane3`, 가지 `feature/lane3-BAT-450B`.
- 출처: 조사 초안 `docs/review/plans/BAT-450-scope.md`, BAT-450A '넘기는 것'(§8), `docs/features/identity.md` §6.1, `docs/security/asvs/offline-gate.md` GAT-210 행, `docs/security/authz-matrix.md` §3.4·AZ-T2·AZ-T3, `docs/api/proto/README.md` 146행, ADR-0285 결정 9, `docs/api/openapi.yaml` 5167~5174, `docs/data.md` `staff_assignment`.
- 차례: 시험 먼저(계획 → 시험 → 구현 → 리뷰 → 검증). 정방향 꼬리말은 달지 않는다.
- 이 파일은 역할마다 자기 절만 쓴다: 계획(아래), 실패 확인(시험), 리뷰(리뷰), 검증(검증), 담당 표(각 역할이 자기 줄).

## 계획

계획 담당 `lane3-bat450b-plan`(deepseek-v4.1-flash), 2026-11-22. 제품 코드·시험은 쓰지 않았다. 계약 결정은 ADR-0353에 적었다.

### 1. 이 묶음이 끝내는 것과 넘기는 것

GAT-210은 초대 **조회·수락·거절**만 R-548에 있고, 초대 **만들기·명단·해제·재발송·메일**이 없다. 이 묶음은 파트너 콘솔이 초대를 만들고 현장 스태프가 메일 링크로 수락하는 길을 서버 쪽에서 끝낸다.

| 정본 | 지금 적힌 것 | 이 묶음이 맞추는 것 |
| --- | --- | --- |
| `docs/features/identity.md` §6.1 | 초대 이메일 여러 개, 24시간·1회용, 토큰은 URL 조각에만, 32바이트 난수·SHA-256 저장 | 만들기·명단·해제·재발송 유스케이스와 시험 |
| `docs/api/openapi.yaml` 5167~5174 | 파트너 초대 네 작업과 `StaffAssignment`(이메일·계정 ID 없음) | 구현·오류 응답(404/409/422/503)을 계약에 맞춤 |
| `docs/security/authz-matrix.md` §3.4 | 배정 회차는 부모의 `promoter_id`로 판정, AZ-T2 읽기·AZ-T3 쓰기 404 | 테넌트는 `principal.tenantId`만 쓰고 core가 준 판매자와 대조 |
| `docs/data.md` `staff_assignment` | `invite_email`은 수락·만료 시 파기, `promoter_id`는 초대 생성이 채움 | 같은 회차·같은 이메일 INVITED 중복을 막는 부분 유일 인덱스와 채움 규칙 |
| `docs/api/proto/README.md` 146 | 회차 판매자 대조 경로가 정본에 없다는 미해결 | ADR-0353으로 내부 HTTP를 정하고 미해결을 닫음 |
| `deploy/gateways/routes/gw-partner.yaml` | `/v1/partner/events/{eventId}/staff*`·`/v1/partner/staff`가 core-svc로 감 | identity-svc로 옮김(그림 `docs/architecture.md` §3.3과 맞춤) |

**넘기는 것(이 묶음이 하지 않는다)**

- **BAT-450C**: 배정 만료 정비(`INVITED`→`EXPIRED`, `ASSIGNED`→`ENDED`), `hasStaffAssignment`·`listSelf` 시간 필터(C2-11), `promoter_id` 백필(C2-10), ASVS `offline-gate.md` GAT-210 행 **재판정**(이 묶음은 닿는 행의 근거 문장만 보강하고 `테스트 결과` 칸은 건드리지 않는다), I-T21의 '만료 정비' 부분, GAT-210 단계 줄 체크.
- **BAT-450D**: 초대·해제·재발송의 불변 감사 기록(표 또는 ops 감사 접수). 이 묶음은 기존 로그·DB 상태까지만.
- **GAT-250/BAT-455**: 운영 이메일 대행사 어댑터. 이 묶음은 메일 포트와 local·ci 파일 대역만.
- **GAT-360/BAT-405**: SCR-037 파트너 화면. **GAT-230·240/BAT-400**: SCR-050·051·061 화면.
- **I-T47**(URL 조각 화면 흐름)은 GAT-230 몫이다. 이 묶음은 서버가 만든 링크가 조각에만 토큰을 싣는 것까지.
- **부스 본인확인(I-T40)**·기존 I-T41~I-T85는 건드리지 않는다.

### 2. 계약 결정(ADR-0353): identity-svc → core-svc 내부 HTTP

두 안을 견줬다.

| 안 | 좋은 점 | 나쁜 점 | 판정 |
| --- | --- | --- | --- |
| A. identity-svc가 core-svc `GET /internal/v1/events/{eventId}/sale-config`를 부른다(내부 토큰) | 이미 있는 읽기 전용 경로, purchase·ticket·ops가 쓰는 같은 모양·같은 토큰, 새 계약 생성물 없음 | `docs/architecture.md` §3.2의 '내부 동기 호출은 gRPC' 예외를 하나 더 넓힘 | **채택** |
| B. core-svc에 업무 gRPC `EventSaleConfigService`를 새로 두고 identity가 부른다 | gRPC 규칙과 method 단위 메시 정책에 맞음 | proto·생성물·서버·배포를 새로 만들면서 같은 값을 한 번 더 옮겨 적음. 한 번의 읽기라 이득이 작음 | 기각 |

- **오류 매핑**: 404(없는 회차·판매 승인 전·다른 파트너 회차) → **404 `not-found`**(같은 본문, AZ-T2·T3). 401·403·5xx·시간 초과·연결 실패·응답 모양 틀림 → **503 `authz-unavailable`**(Retry-After). local·ci에서 주소나 토큰이 없을 때도 같은 503이다.
- **시간 상한**: 5초 [가정](ops-svc `HttpCoreEventOwners`와 같은 값).
- **내부 토큰**: 서비스 사이 공유 토큰 `x-peaket-internal-token`. identity는 `PEAKET_INTERNAL_TOKEN`을 Secret에서 받는다. local·ci는 비어도 core가 검사를 끄므로 그대로 동작한다. 운영에서 identity에 토큰이 없으면 core가 401을 주고 초대 만들기는 503으로 닫힌다(조용히 성공한 척하지 않는다).
- **NetworkPolicy·메시**: `deploy/platform/mesh/port-allow.yaml`의 core-svc REST `callers`에 `identity-svc`를 더하고 `node tools/ci/mesh-policies.mjs --write`로 생성 파일을 다시 만든다. ADR-0285 결정 9 표에도 `identity-svc → core-svc` 줄을 보충한다.
- **판매 승인 전 회차**: `event_sale_config` 사본은 판매 승인 때 생긴다. 그래서 초대는 **판매 승인된 회차에만** 만들 수 있고, 승인 전 회차는 404다. 파트너 콘솔이 승인 전 초대를 필요로 하면 후속 결정으로 넓힌다.
- **유효 시간**: `validFrom = entryOpensAtMs(없으면 startsAtMs) − 3시간`, `validUntil = endsAtMs + 2시간` [가정, docs/data.md `staff_assignment`]. `endsAtMs`가 없으면 모양 오류로 보고 503이다.

### 3. 초대 만들기·명단·해제·재발송

| 작업 | 규칙 |
| --- | --- |
| 만들기 `POST /v1/partner/events/{eventId}/staff-invitations` | `partner_admin`·`partner_member`. 한 번에 1~200명. 각 행은 이메일(소문자로 맞춤)·역할. **요청 안 중복 이메일**과 **같은 회차에 이미 INVITED인 이메일**은 422 `staff-invitation-duplicate`. `account_id`는 NULL, 상태 INVITED. `promoter_id`는 core가 준 값. `invited_by`는 요청 계정. 201은 배정 배열(토큰 없음) |
| 명단 `GET …/staff` | 같은 역할. 회차의 배정을 유효 시작 늦은 순·ID 내림차순, 커서·limit(1~100). **이메일·계정 ID 0건**, 닉네임(수락한 계정만)·역할·상태·만료·유효 시간만. 스캔·예외 통과 건수는 ticket 데이터라 이 묶음은 싣지 않는다(화면은 빈 값) |
| 해제 `DELETE /v1/partner/staff/{assignmentId}` | 같은 역할. 배정 ID로 찾고 그 배정의 회차 판매자를 다시 대조(다른 테넌트·없는 배정 모두 404). INVITED·ASSIGNED면 REVOKED, 이메일·토큰 해시 파기, 살아 있는 스캐너 세션 종료 + `control.sessions-terminated`(`STAFF_REVOKED`). 이미 끝난 배정은 204(멱등) |
| 재발송 `POST /v1/partner/staff/{assignmentId}/invitation` | 같은 역할. INVITED만. 새 32바이트 토큰·새 24시간·옛 해시 교체(옛 토큰 즉시 무효). ASSIGNED·REVOKED·ENDED·EXPIRED는 409 `staff-invitation-already-accepted`(이미 수락·종료). 응답은 배정(토큰 없음) |

- **중복 방지의 DB 백스톱**: 마이그레이션 0036에 부분 유일 인덱스 `staff_assignment_event_invite_email_key ON staff_assignment (event_id, lower(invite_email)) WHERE status = 'INVITED' AND invite_email IS NOT NULL`을 둔다. 23505는 422 `staff-invitation-duplicate`로 사상한다.
- **이메일 모양**: 계약 `zod.email()`이 1차로 본다. 저장은 앞뒤 빈칸 제거·소문자화. 같은 회차의 INVITED 행끼리만 겹침을 막는다(수락 뒤 같은 이메일을 다른 계정이 다시 초대받는 것은 허용).
- **권한**: 정본(openapi)대로 `partner_admin`·`partner_member` 둘 다. 역할 상승(`gate_lead` 초대)은 이 묶음에서 좁히지 않고 BAT-450D 감사와 함께 다시 본다.

### 4. 토큰·링크·메일

- **토큰**: `crypto.randomBytes(32)`를 base64url로(43자). DB에는 SHA-256(hex)만 `bytea`로. 응답·헤더·로그·감사에 원문 0건.
- **링크**: `${PEAKET_STAFF_INVITATION_URL}#token=${token}`. 기본값 `https://peaket.example/staff/invitations` [가정]. 조각(fragment)만 쓰고 쿼리·경로에 토큰을 넣지 않는다.
- **메일 포트**: `StaffInviteMailer`(`to`, `link`, `expiresAt`, `eventId`, `role`, `at`). **local·ci 파일 대역** `FileStaffInviteMailer`는 `PEAKET_STAFF_MAIL_DIR/staff-invite-mail.jsonl`에 한 줄씩 쓴다(`FileAdminMailer`와 같은 꼴, 저장소에 넣지 않는다). 운영 어댑터는 없다.
- **메일이 없을 때**: 만들기·재발송은 **503 `provider-down`**으로 닫는다. 초대 행을 만들고 메일을 못 보낸 척하지 않는다. local·ci도 `PEAKET_STAFF_MAIL_DIR`이 없으면 같다(시험은 메모리 대역을 꽂는다).
- **24시간**: `invite_expires_at = now + 24h`. 만료된 INVITED는 조회·수락에서 410(기존 동작). 만료 정비(EXPIRED 전환·이메일 파기)는 BAT-450C.

### 5. 시험 계획(시험 담당이 구현 전 트리에서 실패를 본다)

| ID | 시험(새 이름) | 잡는 것 |
| --- | --- | --- |
| I-T21 ① | identity `I-T21 ①` 여러 명(3명)·역할·201, 200명 경계·201 초과 422 | 여러 명 초대와 상한 |
| I-T21 ② | identity `I-T21 ②` 요청 안 같은 이메일(대소문자·빈칸) 422, 이미 INVITED인 이메일 422, 수락 뒤 같은 이메일 재초대 201 | 중복 규칙 |
| I-T21 ③ | identity `I-T21 ③` 토큰 43자 base64url·SHA-256만 저장·24시간·`invite_email` 소문자 | 토큰·수명 |
| I-T21 ④ | identity `I-T21 ④` 응답 본문·머리에 토큰 원문 0건, DB 해시만, 로그에 링크 0건 | 토큰 비노출 |
| I-T21 ⑤ | identity `I-T21 ⑤` 다른 파트너 회차·없는 회차 모두 404 같은 본문, 행 0 | 테넌트(AZ-T2·T3) |
| I-T86 ① | core `I-T86 ①` 내부 판매 설정이 promoterId·startsAtMs·endsAtMs·entryOpensAtMs를 주고, 토큰 없으면 401·없는 회차는 404 | core 계약 |
| I-T86 ② | identity `I-T86 ②` 어댑터가 404→undefined, 401·5xx·시간 초과·모양 틀림→던짐, 내부 토큰 머리 | 어댑터 |
| I-T86 ③ | identity `I-T86 ③` core 404→404, 401/5xx/시간 초과/모양 틀림→503 `authz-unavailable`·행 0 | 오류 매핑 |
| I-T21 ⑥ | identity `I-T21 ⑥` 메일 파일 대역: 수신자·`#token=` 조각·24시간·파일에만 원문, 메일 없으면 503·행 0 | 메일 |
| I-T21 ⑦ | identity `I-T21 ⑦` 명단: 이메일·계정 ID 0건, 닉네임은 수락한 계정만, 커서·limit, 테넌트 | 명단 |
| I-T21 ⑧ | identity `I-T21 ⑧` 해제: 204·REVOKED·이메일/토큰 파기·세션 종료·`control.sessions-terminated`·다음 요청 거부, 두 번 204 | 해제 |
| I-T21 ⑨ | identity `I-T21 ⑨` 재발송: 새 토큰·옛 토큰 410·새 토큰 수락, ASSIGNED 409 | 재발송 |
| I-T21 ⑩ | identity `I-T21 ⑩` 만료 토큰 조회·수락 410, 만료된 INVITED 재발송은 새 24시간 | 만료 |
| I-T21 ⑪ | identity `I-T21 ⑪` HTTP: 역할 아님 403, 테넌트 없음 403, `no-store`, 본문 모양 400/422 | 권한·캐시 |

- 단위 시험은 메모리 저장소·가짜 core 대역·메모리 메일 대역·`createService` HTTP로 돌린다. 실제 PostgreSQL이 필요한 중복 인덱스는 `test-int/staff-invitations.int.test.ts`에 둔다(Docker 잠금).
- core 시험은 `services/core-svc/test/internal-sale-config-identity-caller.test.ts`다. 기존 `internal-sale-config-token.test.ts`와 겹치지 않게 **identity가 읽는 칸**만 본다.
- `tools/ci/bat450b-contract.test.mjs`: openapi 네 작업의 오류 응답·문제 유형, `gw-partner` 라우트가 identity-svc를 가리키는지, `port-allow.yaml`의 core REST `callers`에 identity-svc가 있는지 정적으로 본다.

### 6. 계약·정본·배포 파일

- `docs/api/openapi.yaml`: 네 작업에 404(없는/다른 테넌트/승인 전), 409(이미 수락), 422(중복·모양), 503(의존) 응답. 문제 유형 `staff-invitation-duplicate`(422)·`staff-invitation-already-accepted`(409)·`authz-unavailable`(503, 기존) 연결. `StaffAssignment.nickname` 설명에 '초대 중에는 없다'를 더한다.
- `packages/contracts`·`packages/api-client`: `gen`·`gen` 뒤 생성물 커밋.
- `docs/features/identity.md`: §6.1에 BAT-450B 구현 문단, I-T21 판정 칸 ①~⑪, 새 I-T86 행.
- `docs/api/proto/README.md` 146행: 내부 HTTP로 닫았음을 적고 §4 표에서 뺀다.
- `docs/architecture.md` §3.2 REST 행: identity→core sale-config를 내부 HTTP 예외 목록에 더한다.
- `docs/api/guidelines.md` §8.1: identity→core 판매 설정 읽기의 실패 모양(404/503, 5초) 행.
- `docs/security/authz-matrix.md` §3.4: 초대 만들기·명단·해제·재발송의 테넌트 규칙과 AZ-T3.
- `docs/security/asvs/offline-gate.md`: 6.5.1(1회용)·6.5.3(난수)·6.5.5(24시간)·8.2.1(권한)·14.2.1(조각)·14.3.2(no-store)·16.2.5(로그 금지)·16.3.1(기록)의 근거 문장에 초대 만들기·재발송·해제를 더한다. **재판정·`테스트 결과` 갱신은 BAT-450C**.
- `docs/data.md` `staff_assignment`: 32바이트·24시간·중복 인덱스·해제 시 파기.
- `deploy/workloads/identity-svc/values.yaml`: `PEAKET_CORE_HTTP_URL: http://core-svc:8080`. 내부 토큰은 Secret(배포 단계에서 `PEAKET_INTERNAL_TOKEN`을 identity Secret에 더한다 — 남은 위험).
- `deploy/envs/local/demo/identity-svc.yaml`: `PEAKET_CORE_HTTP_URL`·`PEAKET_STAFF_MAIL_DIR=/tmp/staff-mail`.
- `deploy/platform/mesh/port-allow.yaml` + 생성 파일, `deploy/gateways/routes/gw-partner.yaml` + 생성 라우트.

### 7. 게이트

```bash
pnpm --filter @peaket/identity-svc typecheck
pnpm --filter @peaket/core-svc typecheck
pnpm --filter @peaket/identity-svc test
pnpm --filter @peaket/core-svc test test/internal-sale-config-identity-caller.test.ts
pnpm --filter @peaket/contracts gen:check
pnpm --filter @peaket/api-client test
pnpm lint
python -I -X utf8 tools/doc-check/check_all.py
node tools/ci/gateway-routes.mjs --check
node tools/ci/mesh-policies.mjs --check
node --test tools/ci/bat450b-contract.test.mjs
node tools/ci/trace-check.mjs --ids "I-T21,I-T86" --report <vitest JSON>
node tools/ci/ledger.mjs --batch BAT-450B --require
node tools/ci/roles-check.mjs --base origin/develop --head HEAD
node tools/ci/records.mjs --check
```

Docker 시험은 `services/identity-svc/test-int/staff-invitations.int.test.ts`를 잠금 안에서 돌린다. 끝나면 `docker ps`에 peaket 컨테이너 0을 확인한다.

### 8. 자주 놓친 결함을 이 묶음에 대 본 것

| 항목 | 이 묶음 |
| --- | --- |
| 값 단언(모양만 아님) | 토큰 길이·해시·만료 시각·상태·세션 종료 수·`control` 페이로드를 값으로 본다 |
| 경계값 양쪽 | 200명/201명, limit 1·100/101, 만료 정확히 그 시각/1ms 뒤, `entryOpensAtMs` 없음/있음 |
| 지우거나 옮기는 연산은 키를 모두 확인 | 해제 뒤 `invite_email`·`invite_token_hash`·세션·아웃박스, 재발송 뒤 옛 해시 |
| 판정 함수만 말고 부르는 쪽 | HTTP 상태·`RolesGuard`·`@CurrentPrincipal().tenantId`·core 어댑터 |
| 같은 규칙 두 곳 | 메모리·Drizzle 저장소의 중복·해제·재발송, 파일·메모리 메일 대역 |
| 시험 값이 상수와 같으면 숨음 | 이벤트·계정·토큰은 코드 상수와 다른 고정 값 |
| 장애 주입이 끝까지 닿는가 | core 503·모양 틀림, 메일 없음, DB 23505 |
| 시간 한도 | 24시간, 5초 core 상한, 만료 410 |
| 시작 파일 조립 | `main.ts`에 core URL·토큰·메일 폴더·초대 URL이 닿는지 typecheck·단위 |

## 실패 확인

시험 담당 `lane3-bat450b-test`(deepseek-v4.1-flash), 2026-11-22 13:10~13:15 KST. 기준 트리 `3129756b4`(계획 커밋)에서 구현 없이 시험만 더해 돌렸다. Docker는 쓰지 않았다.

### 단위·HTTP(구현 전)

| 파일 | 결과 | 실패한 시험(까닭) |
| --- | --- | --- |
| `services/identity-svc/test/partner-staff-invitations.test.ts` | **12개 중 12 실패** | 라우트가 없어 만들기·명단·해제·재발송이 404/400이다. I-T21 ①~⑪·I-T86 ③이 `201/200/204/503`을 기대하는 자리에서 404·400이 왔다. `I-T21 ⑤`는 404 본문 비교를 `instance`(요청 주소)까지 견주어 실패했고, 타입·상태·제목만 견주도록 시험을 고쳤다(구현 전 트리에서 여전히 404 자체가 없어 실패) |
| `services/identity-svc/test/http-core-event-owners.test.ts` | **0개(파일 실패)** | `Cannot find module '../src/modules/session/adapters/http-core-event-owners.js'`. 새 어댑터 파일이 없다 |
| `services/identity-svc/test/staff-invite-mailer.test.ts` | **0개(파일 실패)** | `Cannot find module '../src/modules/session/adapters/file-staff-invite-mailer.js'`. 새 파일 대역이 없다 |
| `services/core-svc/test/internal-sale-config-identity-caller.test.ts` | **2개 통과** | 기존 sale-config 경로에 identity가 읽는 칸(`promoterId`·`startsAtMs`·`endsAtMs`·`entryOpensAtMs`)이 이미 있다. 계약 회귀 시험이라 구현 전에도 통과한다(뒤 틀린 구현 표본으로 판정 능력을 본다) |
| `tools/ci/bat450b-contract.test.mjs` | **4개 중 4 실패** | openapi에 `staff-invitation-duplicate`·`staff-invitation-already-accepted`·네 작업의 404/409/422/503 응답과 `minItems: 1`이 없다. gw-partner 원천·생성 라우트가 아직 core-svc를 가리킨다. core-svc REST `callers`에 identity-svc가 없다 |

### 판정

- 새 동작(초대 만들기·명단·해제·재발송·core 대조·메일)은 구현 전 트리에서 **경로 없음(404/400)**과 **모듈 없음(import)**으로 실패했다. 값 단언으로 실패한 것은 HTTP 시험 12개이고, 어댑터·메일 대역은 파일이 없어 수집 단계에서 실패했다.
- core 계약 시험은 기존 동작이라 통과한다. 이 시험이 identity가 읽는 칸을 실제로 잡는지는 `## 검증`의 틀린 구현 표본으로 본다.
- Docker 통합 시험(중복 인덱스·실제 PostgreSQL)은 이번 실패 확인에서 돌리지 않았다. `test-int/staff-invitations.int.test.ts`에 0036 부분 유일 인덱스, `createInvitations`·`findInvitedEmails`, `listByEvent`, `revokeAssignment`, `reissueInvitation` 시험을 더했다. 구현 전 트리에는 새 저장소 메서드와 0036이 없어 그 시험들은 `TypeError`(메서드 없음)와 인덱스 없음으로 실패한다. 구현 뒤 잠금을 잡고 돌린다.
- 기존 시험의 시드 하나(A2, 같은 회차·같은 이메일 INVITED)는 0036 인덱스와 충돌해 이메일을 `lead@example.com`으로 바꾸고, 중복 배정 시험에서 A1 수락 뒤 같은 이메일로 맞추게 고쳤다. 인덱스가 INVITED끼리만 겹침을 막는 성질을 시험이 그대로 지킨다.

## 리뷰

(리뷰 담당이 채운다)

## 검증

(검증 담당이 채운다)

## 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | lane3-bat450b-plan | deepseek-v4.1-flash | 2026-11-22T13:05:00+09:00 | 2026-11-22T13:08:00+09:00 |
| test | lane3-bat450b-test | deepseek-v4.1-flash | 2026-11-22T13:10:00+09:00 | 2026-11-22T13:16:00+09:00 |
