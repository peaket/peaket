# 작업 계획: W9-fix3(권한·보안·개인정보 작은 고침 여섯)

- **무엇**: 세 갈래 정리 목록 가운데 권한·보안·개인정보 여섯 줄을 고치는 일의 작업 목록이다(소유자 결정 2026-11-17 '정리 목록 가운데 돈·권한·개인정보 작은 고침부터'). 검토 기록이고 규범이 아니다. 정본과 다르면 정본이 이긴다.
- **바탕**: 작업 폴더 `D:/ticketpass-w9-fix3`, 가지 `feature/w9-fix3`, 출발점 `origin/develop` `9199a3de`. 2026-11-17 계획 담당 `w9f3-plan`(claude-opus-5-5). 시험·제품 코드는 쓰지 않았다.
- **묶음 ID와 차례**: 묶음 표에 없는 일이라 이 파일 이름을 쓴다. 재현 시험 먼저 묶음이다(`Batch-Order`를 달지 않는다). 차례는 계획 → 시험(재현 먼저, 구현 전 트리에서 실패 확인) → 구현 → 리뷰 → 검증 → 기록이다.
- **등급**: B. 다만 권한 항목(1·2·3·5)은 틀린 구현 표본에 꼭 넣는다(아래 §5).
- **정본**: 이 커밋에서 먼저 고쳤다(§7). docs/security/authz-matrix.md §5.3 'ops-svc 구현'·§5.1 '게이트웨이가 요구하는 스코프', docs/architecture.md §3.2 'REST' 행·§5 포트별 허용 표 'REST 포트' 행, docs/security/asvs/settlement.md v5.0.0-11.2.4, docs/infra.md §4.1 '인증 종류 대조' ④, docs/api/guidelines.md §7 '본문을 읽기 전의 차례'·'본문을 다 읽기 전에 답하면 연결을 닫는다', docs/features/search.md §11 '검색어 가리기'.

## 계획

### 1. 범위

| # | 출처(정리 목록) | 고칠 것 |
| --- | --- | --- |
| F1 | docs/lanes/lane3.md, BAT-420(GAT-110) 구현 담당이 남긴 것 | ops-svc 파트너 풀의 DB 역할 시작 검사 |
| F2 | docs/lanes/lane3.md, W7-audit(S4) | 내부 토큰 비교의 길이 조기 종료(HTTP·gRPC 둘 다) |
| F3 | docs/PROGRESS.md 갈래 1 정리 목록, BAT-060(R-666, RV-07) | 라우트 생성기가 이상한 `x-peaket-scopes`를 조용히 버림 |
| F4 | docs/lanes/lane2.md, HOT-190 '선언 길이가 본문 상한을 넘으면…' | 본문을 다 읽기 전에 답할 때 연결을 닫지 않음 |
| F5 | docs/lanes/lane2.md, HOT-240 '큰 본문 칸막이를 인증 가드보다 먼저…' | 칸막이 자리를 신원 판정보다 먼저 잡음 |
| F6 | docs/lanes/lane2.md, BAT-165 R-663 W7L2-S11 | 검색어 가리기의 구분자 목록이 좁음 |

- **F5는 범위에 남긴다(게이트웨이로 다 막히지 않는다)**: 게이트웨이 쪽은 막혀 있다. `deploy/gateways/gw-partner.yaml`의 `gw-partner-api-security`(대상 라우트 `gw-partner-api`·`gw-partner-api-2`, 공연 이미지·좌석맵 저장·가져오기·판매 자격 명단 경로가 모두 이 둘에 있다)가 `jwt`와 `authorization.defaultAction: Deny`로 머리 단계에서 거르므로, 토큰 없는 요청의 본문은 서비스에 가지 않는다. 그러나 게이트웨이를 거치지 않는 길이 남는다. 내부 HTTP(`/internal/v1/…`)를 부르는 서비스(purchase·payment·ops·ticket)는 core-svc의 같은 REST 포트에 닿아야 하고, 노드 프록시·NetworkPolicy는 경로로 거르지 못한다(docs/architecture.md §5 포트별 허용 표, 이 커밋에서 적음). 그래서 서비스 안 차례를 정한다.
- **F4의 실제 결함은 '본문을 읽기 전에 답하는 길'이다**: 계획 담당이 따로 재 봤다(2026-11-17, 저장소 밖 임시 스크립트, Fastify 5.12.7·Node 24, 맨 Fastify에 플랫폼과 같은 꼴의 multipart 해석기). 해석기에서 낸 413(선언 길이·chunked 넘침, JSON `bodyLimit`)은 Fastify `onDone`이 `connection: close`를 달아 응답 뒤 소켓을 닫았다. 그러나 `onRequest`에서 끝낸 429(칸막이 참)는 `keep-alive`로 답하고 1.5초 동안 보낸 6MB를 끝까지 읽었다(선언 길이·chunked 둘 다). F5가 더하는 401·403·503도 같은 길이다. 그래서 413 시험은 회귀 막기로, 429 시험이 재현이다. 실제 실패 여부는 시험 담당이 '실패 확인'에 적는다.
- **범위 밖**: HOT-190·HOT-240의 다른 줄(멱등 키, 포스터 23505, ETag 약한 꼴, 남의 배치본 ID 보안 사건 등), 관제 풀(`ops_app`) 역할 검사, core-svc `assertDatabaseRole`을 platform으로 옮기기, 고정 길이 값끼리의 다른 `timingSafeEqual` 자리(identity·purchase-auth 등, 길이가 늘 같다), 정본의 내부 HTTP 예외 목록 정리(§3.2 REST 행은 하나만 적었으나 실제 내부 HTTP는 더 많다. 정리 목록에 넘길 것).

### 2. 지적별 바른 동작과 정본 근거

| # | 바른 동작 | 정본 |
| --- | --- | --- |
| F1 | `PEAKET_PARTNER_DATABASE_URL`이 있으면(환경과 상관없이, 관제 주소와 글자까지 같아도) 시작 때 그 풀의 사용자가 ① `ops_partner` 구성원 ② `ops_app` 구성원 아님 ③ 슈퍼유저·`BYPASSRLS` 아님 ④ `event_cancellation_request`의 소유자(소유 역할의 구성원 포함) 아님을 본다. 어긋나면 까닭을 적어 던지고 시작하지 않는다(서비스가 요청을 받기 전). 주소가 없어 local·ci가 관제 풀을 함께 쓰면 보지 않고 지금 경고만 | authz-matrix §5.3 'ops-svc 구현' 끝 '시작 검사', 같은 절 '앱 사용자는 표 소유자가 아니게' |
| F2 | 공용 비교 하나: 받은 값과 기대 값을 각각 SHA-256(utf8)으로 줄인 32바이트를 `timingSafeEqual`로 정확히 한 번 견준다. 길이가 달라도 일찍 끝내지 않는다. 기대 값이 빈 문자열이면 false(지금처럼 가드가 먼저 막는다). HTTP `InternalTokenGuard`(그래서 core `InternalToken401Guard`도)와 내부 gRPC(토큰·처리자 증명) 둘 다 이것을 쓴다 | architecture §3.2 'REST' 행, asvs/settlement.md v5.0.0-11.2.4 |
| F3 | `x-peaket-scopes` 칸이 있는데 값이 이상하면 `authKindOf`가 `problem`을 돌려 생성기가 그 작업과 까닭을 보이고 2로 멈추고 파일을 쓰지 않는다. 이상한 값: 배열 아님(null·문자열 하나 포함), 빈 배열, 문자열 아닌 원소, 아는 값(`ticket:buy`)이 아닌 원소(대소문자·앞뒤 공백 다름 포함), 같은 값 두 번, `ticket:buy`인데 `token`이 아닌 작업(한 갈래라도 액세스 토큰 넷이 없음). 칸이 없으면 지금 그대로 | infra §4.1 '인증 종류 대조' ④, authz-matrix §5.1 '게이트웨이가 요구하는 스코프' |
| F4 | 본문을 다 읽기 전에 오류로 답하는 모든 길(413 본문 상한, 429 칸막이, F5의 401·403·503)은 `Connection: close`를 달고 응답을 다 보낸 뒤 연결을 닫는다. 정상 응답은 keep-alive 그대로 | guidelines §7 '본문을 다 읽기 전에 답하면 연결을 닫는다' |
| F5 | 칸막이를 단 경로는 ① 신원(공용 가드 앞부분과 같은 판정: 신원 머리 셋 → 종료 세션 → 대상 → 스코프 → 관리 대상이면 identity 세션 판정·비밀번호 바꾸기 필요 세션·역할, 역할 캐시 씀) ② 칸막이 자리 ③ 본문 ④ 공용 가드 전체 차례다. ①에서 막히면 가드와 같은 오류이고 자리·본문이 없다(F4대로 닫음). 허용 역할에 `public`이 있으면 ①을 건너뛴다. 칸막이 경로에 처리기 `@Roles`가 없으면(클래스에만) 서비스가 시작하지 않는다 | guidelines §7 '본문을 읽기 전의 차례', architecture §5 'REST 포트' 행 |
| F6 | 구분자에 빗금(`/`)·역빗금(`\`)·밑줄(`_`)·쉼표(`,`)·가운뎃점(`·`, U+00B7)을 더한다(하이픈·점·공백·괄호는 그대로, 1~3글자 상한 그대로). 날짜 `2026/11/17`·`1,000,000`도 `[숫자]`가 된다 | search.md §11 '검색어 가리기', SR-T17 |

### 3. 손댈 파일·인터페이스(구현 담당)

| # | 파일 | 인터페이스 |
| --- | --- | --- |
| F1 | ops-svc 새 `src/adapters/db/database-role.ts`, `src/event-cancellation-wiring.ts`, `src/main.ts` | `export async function assertOpsPartnerRole(database: Database): Promise<void>`(core `database-role.ts`와 같은 꼴의 SQL 한 번, 어긋나면 `Error`). `export function partnerRoleCheckRequired(env): boolean`(= `PEAKET_PARTNER_DATABASE_URL`이 비지 않음). main.ts는 `partnerDatabase`를 만든 뒤, 서비스를 띄우기 전에 `if (partnerRoleCheckRequired(process.env)) await assertOpsPartnerRole(partnerDatabase)` |
| F2 | platform 새 `src/secret-compare.ts`, `src/auth.ts`·`src/internal-grpc.ts`(두 `sameSecret`을 지우고 바꿈), `src/index.ts` | `export function constantTimeEqual(given: string, expected: string): boolean` |
| F3 | `tools/ci/gateway-routes.mjs`(`authKindOf`) | `export const KNOWN_SCOPES = ['ticket:buy']`. `authKindOf`의 반환 꼴은 그대로(`{ kind?, problem? }`), 까닭 글에 `x-peaket-scopes`와 그 값 |
| F4·F5 | platform `src/request-checks.ts`(`installRequestChecks`, 칸막이 훅), `src/auth.ts`(`Roles`, `AuthGuard`), `src/service.ts`(인증 상태 넘기기) | `installRequestChecks(http, auth: AuthState)`(필수 인자). `export const ROUTE_ROLES_KEY = 'peaketRoles'`: 처리기에 단 `@Roles`가 경로 설정에도 정책을 적는다. `export async function admitBeforeBody(state: AuthState, policy: RolesPolicy, headers: FastifyRequest['headers']): Promise<void>`(가드와 같은 오류를 던짐). `AuthGuard`와 이 함수는 신원 판정 한 함수를 함께 쓴다(둘이 갈라지지 않게). 본문 전 오류는 `reply.header('connection', 'close')` 뒤 `done(err)`. multipart 413 두 길도 Fastify에 기대지 않고 직접 단다 |
| F5 | core-svc·purchase-svc 제품 코드는 바꿀 것이 없을 것이다(칸막이 경로가 모두 처리기 `@Roles`). 기존 칸막이 시험이 신원 머리 없이 429를 기대하면 시험 담당이 머리를 단다 | — |
| F6 | core-svc `src/modules/catalog/domain/search.ts`(`isSep`, 주석) | 바뀌지 않음(`maskSearchQuery`) |

### 4. 재현 시험(시험 담당이 먼저 쓴다. 이름은 지적 ID로 시작)

| 시험 | 종류·파일 | 단언 |
| --- | --- | --- |
| `W9F3 F1 ops 파트너 풀 사용자의 DB 역할을 시작 때 본다` | 통합 ops `test-int/event-cancellation-rls.int.test.ts`(PostgreSQL 18, 실제 역할) | `ops_partner`만 가진 로그인 사용자 → 됨. 표 소유자(마이그레이션 사용자) → 던짐 `/행 보안/`. `ops_app`만 → 던짐 `/ops_partner/`. 둘 다 → 던짐 `/ops_app/`. `ops_partner` + `BYPASSRLS` → 던짐. 소유 역할의 구성원 → 던짐 |
| `W9F3 F1 파트너 DB 주소가 있으면 환경과 같은 주소 여부와 상관없이 역할 검사를 부른다` | 단위 ops `test/event-cancellation-main-wiring.test.ts` | `partnerRoleCheckRequired`: production·ci·local 각각 주소 있음 → true, 없음·빈 값 → false. main.ts 글에서 `assertOpsPartnerRole(partnerDatabase)`가 그 조건 아래에 있고 서비스 시작(`createService`/listen)보다 앞이며, `partnerUrl === url` 조건으로 건너뛰지 않는다 |
| `W9F3 F2 SEC-06R ⑤ 공용 비교는 길이와 상관없이 해시 둘을 한 번 견준다` | 단위 platform `test/internal-token-constant-time.test.ts`(옛 ⑤를 고쳐 씀) | 같은 값·같은 길이 틀린 값·짧은 값·긴 값·빈 값·글자 수는 같고 바이트 수가 다른 한글 값 각각: `timingSafeEqual` 정확히 1번, 두 인자 32바이트, 인자 = SHA-256(받은 값)·SHA-256(기대 값), 결과는 같을 때만 true. 옛 단언 '길이가 다르면 0번'은 정본이 바뀌어 뒤집는다(시험 이의 아님) |
| `W9F3 F2 SEC-06R ④ 내부 판매 설정 가드도 길이가 다른 토큰을 해시로 견주고 401이다` | 단위 core `test/internal-sale-config-token-boot.test.ts`(옛 ④를 고쳐 씀) | `'short'` → 401이고 `timingSafeEqual` 1번(32바이트 둘). 맞는 토큰 200 |
| `W9F3 F2 내부 gRPC 토큰·처리자 증명도 공용 비교를 쓴다` | 단위 platform 같은 파일 | `verifyInternalGrpcActor`에 길이 다른 토큰 → `{ ok: false, reason: 'token' }`이고 `timingSafeEqual`이 32바이트 인자로 불림. 길이 다른 처리자 증명 → reason `actor`, 같음 |
| `W9F3 F3 RV-07 x-peaket-scopes 값이 이상하면 authKindOf가 문제를 돌린다` | 단위 `tools/ci/gateway-routes.test.mjs` | 모두 fanCookie 갈래에서: `'ticket:buy'`(문자열)·null·`[]`·`['ticket:buyy']`·`['Ticket:Buy']`·`[' ticket:buy']`·`[1]`·`['ticket:buy','ticket:buy']` → problem(값이 까닭에 듦). `['ticket:buy']` + 갈래 `[{fanCookie:[]},{}]`·`security: []`·`[{admissionToken:[]}]`(fanCookie 없음) → problem. 대조: `['ticket:buy']` + 모두 fanCookie → `token-buy`, 칸 없음 → `token` |
| `W9F3 F3 RV-07 그런 작업이 하나라도 있으면 CLI가 2로 멈추고 생성 파일을 쓰지 않는다` | CLI 같은 파일(임시 폴더 `--root`) | `--write`: 끝 코드 2, 까닭 줄에 그 계약 경로와 `x-peaket-scopes`, 생성 파일 없음. 저장소 그대로면 `--check` 0(기존 D-T42 시험) |
| `W9F3 F4 칸막이가 찼을 때 429는 연결을 닫고 남은 본문을 읽지 않는다` | 단위(실제 소켓) platform `test/body-limit.test.ts` | 한도 1 칸막이를 붙잡은 뒤 ① 머리만(선언 8MiB) → 429·`connection: close`·2초 안에 서버가 닫음 ② 선언 8MiB를 5ms마다 64KiB씩 보냄 ③ chunked로 같게: 서버 쪽 소켓 `bytesRead`(그 연결 close 때) ≤ 1MiB [가정, 시험 문턱]·2초 안에 닫힘. 지금은 keep-alive로 다 읽는다(재현) |
| `W9F3 F4 본문 상한 413도 연결을 닫는다(회귀)` | 같은 파일 | multipart 선언 길이 넘침(머리만)·multipart chunked 넘침·JSON `@BodyLimit` 선언·chunked: 413(이름 붙은 Problem 그대로)·`connection: close`·서버 닫음·`bytesRead` ≤ 1MiB |
| `W9F3 F4 정상 요청은 연결을 다시 쓴다` | 같은 파일 | 상한 안 본문 두 요청을 한 연결로: 둘 다 200, 응답에 `connection: close` 없음 |
| `W9F3 F5 신원 없는 요청은 칸막이 자리를 쥐지 못하고 본문을 기다리지 않는다` | 단위(실제 소켓) platform 새 `test/bulkhead-auth.test.ts`(partner 역할 칸막이 경로 한도 1, 가짜 `AdminAuthzPort`) | 신원 머리 없이 머리만 보낸 요청 둘 → 본문 없이도 바로 401·`www-authenticate`·`connection: close`, 처리기 0. 그 뒤 옳은 partner 요청이 429 없이 200. 지금은 첫 요청이 본문을 기다리며 자리를 쥔다(재현) |
| `W9F3 F5 앞 판정은 가드와 같은 거절을 자리 잡기 전에 낸다` | 같은 파일 | 대상 틀림(`x-user-aud: fan`) 401, 종료 세션 401, identity `valid: false` 401, identity 던짐·시간 초과 503 `authz-unavailable`, 역할 밖(`partner_admin`만 허용에 `partner_member`) 403, 스코프 없음(팬 `ticket:buy` 경로) 403. 모두 자리 0(뒤 요청이 바로 들어감)·처리기 0·본문 해석 0 |
| `W9F3 F5 옳은 신원은 지금처럼 처리되고 identity는 캐시로 한 번만 묻는다` | 같은 파일 | 200, 가짜 포트 부름 1(앞 판정 + 가드), 처리기가 받은 `Principal`의 역할·테넌트가 포트 값. `public` 칸막이 경로는 신원 없이 지금처럼(기존 body-limit 시험 그대로 통과) |
| `W9F3 F5 칸막이 경로의 허용 역할이 클래스에만 있으면 서비스가 시작하지 않는다` | 같은 파일 | `createService`가 던짐(까닭에 경로) |
| `W9F3 F5 core 좌석맵 저장은 신원 없이 칸막이를 쥐지 못한다` | 단위 core(HTTP 시험 틀, 새 `test/partner-bulkhead-auth.test.ts`) | `PUT /v1/partner/productions/{id}/seatmap` 신원 없음 → 401·본문 전, 이어 옳은 요청이 429가 아님 |
| `W9F3 F6 SR-T17 빗금·밑줄·쉼표·역빗금·가운뎃점으로 이은 번호도 가린다` | 단위 core `test/search-log.test.ts` | `010/1234/5678`·`010_1234_5678`·`010,1234,5678`·`010\1234\5678`·`010·1234·5678`·`010 / 1234 / 5678` → `[전화]`, `+82/10/1234/5678` → `[전화]`, `1234/5678/9012/3456`·`2026/11/17` → `[숫자]`. 남음: `루멘 2/3회`, `2026_루멘`, 구분자 4글자 `010////1234`(잇지 않아 그대로) |
| `W9F3 F6 SR-T17 정규화 뒤 가리기: 전각 빗금 번호도 로그에 남지 않는다` | 단위 core `test/search.http.test.ts` | `０１０／１２３４／５６７８` 검색 → `search_query` 줄에 `[전화]`, 숫자 0개. 검색 결과는 가리기 전 값으로 찾은 것과 같다 |

### 5. 틀린 구현 표본(검증 담당이 넣을 것, 14개)

| # | 틀린 구현 | 잡는 시험 |
| --- | --- | --- |
| M-F1a | main.ts에서 시작 검사 호출을 뺀다 | F1 시작 조립 |
| M-F1b | 소유자 검사를 뺀다(역할만 본다) | F1 통합(표 소유자·소유 역할 구성원 줄) |
| M-F1c | 파트너 주소가 관제 주소와 같으면(같은 풀) 건너뛴다 | F1 시작 조립(같은 주소 줄) |
| M-F2a | 해시 전에 길이 비교로 일찍 끝낸다(옛 동작) | F2 ⑤(짧은·긴·한글 값 줄), F2 ④ |
| M-F2b | HTTP만 고치고 `internal-grpc.ts`의 `sameSecret`은 그대로 둔다 | F2 gRPC |
| M-F3a | 모르는 스코프를 버린다(옛 동작) | F3 authKindOf(모르는 값·대소문자·공백 줄) |
| M-F3b | 배열이 아니면 `[]`로 본다(`?? []` + `Array.isArray`) | F3 authKindOf(문자열·null 줄), F3 CLI |
| M-F3c | `ticket:buy`가 있어도 토큰 없는 갈래가 섞이면 `public`·`optional`로 넘긴다 | F3 authKindOf(갈래 줄) |
| M-F4a | 선언 길이가 있을 때만 닫고 chunked·흘려보내기 429는 닫지 않는다 | F4 429 ③ |
| M-F4b | 모든 응답에 `connection: close`를 단다(과한 고침) | F4 정상 요청 |
| M-F5a | 신원 판정을 칸막이 자리 뒤에 둔다(옛 차례) | F5 신원 없음, F5 core |
| M-F5b | 앞 판정에서 identity 세션 판정을 뺀다(머리만 본다) | F5 앞 판정(`valid: false`·503 줄) |
| M-F5c | 앞 판정에서 대상(aud) 검사를 뺀다 | F5 앞 판정(대상 틀림 줄) |
| M-F6a | 구분자에 `/`만 더한다 | F6(`_`·`,`·`\`·`·` 줄) |

- 자주 놓친 결함 대 본 것: 겹친 가드는 하나씩(F1 역할·겸함·특권·소유자, F5 머리·종료 세션·대상·스코프·identity), 경계(F4 `bytesRead` 문턱·2초, F6 구분자 3/4글자), 목록 밖 값(F3 null·빈 배열·숫자 원소, F2 빈 값·바이트 수가 다른 한글), 장애 주입이 실제로 끼어들었는지(F4는 먼저 칸막이가 찼다고 단언, F5 identity 던짐), 시작 파일 조립을 따로(F1 main.ts, F5 service.ts가 인증 상태를 넘기는지는 F5 신원 없음 시험이 실제 `createService`로 본다), 과한 고침(M-F4b).

### 6. 돌릴 시험 명령

```
cd /d/ticketpass-w9-fix3/packages/platform && npx vitest run test/body-limit.test.ts test/bulkhead-auth.test.ts test/internal-token-constant-time.test.ts test/internal-token.test.ts test/internal-token-boot.test.ts && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-w9-fix3/services/core-svc && npx vitest run test/internal-sale-config-token-boot.test.ts test/partner-bulkhead-auth.test.ts test/search-log.test.ts test/search.http.test.ts && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-w9-fix3/services/ops-svc && npx vitest run test/event-cancellation-main-wiring.test.ts test/event-cancellation-wave-review.test.ts && npx tsc -p tsconfig.json --noEmit
cd /d/ticketpass-w9-fix3/services/purchase-svc && npx vitest run test/write-bulkhead.test.ts test/orders-http.test.ts test/accept-http.test.ts test/order-identity.test.ts
cd /d/ticketpass-w9-fix3 && node --test tools/ci/gateway-routes.test.mjs && node tools/ci/gateway-routes.mjs --check
```

- purchase-svc 줄은 회귀 확인이다(칸막이 경로가 F5 앞 판정을 새로 거친다). 각 서비스의 전체 단위 시험(`npx vitest run`)도 게이트 때 한 번 돈다.
- 통합(Docker, 감독이 잠금을 잡은 때만): `cd /d/ticketpass-w9-fix3/services/ops-svc && npx vitest run --config vitest.integration.config.mjs test-int/event-cancellation-rls.int.test.ts`.

### 7. 정본 빈칸과 정한 것(이 커밋에서 정본에 씀, 모두 '추천 적용 2026-11-17, W9-fix3')

| 빈칸 | 정한 것 | 쓴 곳 |
| --- | --- | --- |
| ops 파트너 풀의 시작 검사가 없었다 | §2 F1. 주소가 있으면 늘 보고, 관제 풀은 넣지 않는다 | authz-matrix §5.3 'ops-svc 구현' 끝 |
| 토큰 비교가 '길이가 다르면 비교 없이 거절'로 적혀 있었다 | SHA-256 뒤 한 번 비교, gRPC도 같다 | architecture §3.2 'REST' 행, asvs/settlement.md 11.2.4 |
| 스코프 칸이 이상할 때 생성기 동작이 없었다 | infra ④의 목록. 아는 값은 `ticket:buy` 하나 | infra §4.1 '인증 종류 대조' ④, authz-matrix §5.1 |
| REST 포트 허용 표가 내부 HTTP 호출자를 빠뜨렸다 | 내부 HTTP 호출자도 같은 포트에 닿고 경로로 못 거른다고 적음 | architecture §5 'REST 포트' 행 |
| 칸막이·본문·인증의 서비스 안 차례가 없었다 | ①신원 ②자리 ③본문 ④가드 전체. `public` 경로는 ① 없음 | guidelines §7 '본문을 읽기 전의 차례' |
| 본문 전 오류의 연결 처리가 없었다 | `Connection: close` + 응답 뒤 닫기. 보내는 중인 클라이언트가 응답 대신 끊김을 볼 수 있음은 받아들인다(늦춰 닫기는 하지 않는다) | guidelines §7 '본문을 다 읽기 전에 답하면 연결을 닫는다' |
| 검색어 가리기 구분자 | `/`·`\`·`_`·`,`·`·` 더함, 날짜도 `[숫자]` | search.md §11 |

- 수치: 시험 문턱 `bytesRead` ≤ 1MiB·닫힘 2초는 시험에만 쓰는 [가정]이다(지금 결함은 1.5초에 6MB를 읽었다). 제품 수치는 새로 정하지 않았다.
- 정본 시험 표(search.md SR-T17 등)에는 줄을 더하지 않았다. 시험 이름은 지적 ID(`W9F3 F…`)와 기존 ID(SEC-06R·SR-T17·RV-07)로 시작한다.
- ADR은 쓰지 않았다(방향을 바꾸는 결정이 없다. F2는 W7-audit 지적을 정본에 반영, F5는 ADR-0257 결정 2·ADR-0260 결정 11의 '본문을 읽기 전 자리'에 신원 단계를 앞에 더한 것이다).

## 실패 확인

- **누가·어디서**: 시험 담당 `w9f3-test`(claude-opus-5-5), 2026-11-17, 구현 전 트리 `b165df27` 위에 시험 커밋 `0c8d8b62`. 단위는 패키지·서비스 폴더에서 `node_modules/.bin/vitest run <파일들>`, tools는 `node --test`, F1 통합은 Docker 잠금(`D:/ticketpass-locks/docker`)을 잡고 `vitest.integration.config.mjs`로 돌렸다(컨테이너 접두 `w9f3-test-`, 끝난 뒤 남은 컨테이너 0, 잠금 지움).
- **수**: 새로 쓰거나 고쳐 쓴 시험 17개(§4의 17줄과 하나씩 짝) 가운데 **14개 실패, 3개 처음부터 통과**.

| 시험 | 파일 | 결과 | 실패 까닭(지금 구현) |
| --- | --- | --- | --- |
| W9F3 F1 ops 파트너 풀 사용자의 DB 역할을 시작 때 본다 | ops `test-int/event-cancellation-rls.int.test.ts` | 실패 | 뼈대 `assertOpsPartnerRole`이 아무것도 보지 않아 표 소유자(슈퍼유저) 풀에서 던지지 않는다('promise resolved undefined instead of rejecting'). ops_partner만 → 됨 줄은 통과 |
| W9F3 F1 파트너 DB 주소가 있으면 … 역할 검사를 부른다 | ops `test/event-cancellation-main-wiring.test.ts` | 실패 | `partnerRoleCheckRequired`가 없다(뼈대 false). main.ts도 역할 검사를 부르지 않는다 |
| W9F3 F2 SEC-06R ⑤ 공용 비교는 길이와 상관없이 해시 둘을 한 번 견준다 | platform `test/internal-token-constant-time.test.ts` | 실패 | `constantTimeEqual`이 없다(뼈대 false). 가드는 받은 바이트를 그대로 견주고 길이가 다르면 비교 없이 끝낸다 |
| W9F3 F2 내부 gRPC 토큰·처리자 증명도 공용 비교를 쓴다 | 같은 파일 | 실패 | `internal-grpc.ts`의 `sameSecret`이 길이가 다르면 `timingSafeEqual`을 부르지 않는다(0번) |
| W9F3 F2 SEC-06R ④ 내부 판매 설정 가드도 … 해시로 견주고 401이다 | core `test/internal-sale-config-token-boot.test.ts` | 실패 | 비교 인자가 32바이트 해시가 아니라 토큰 바이트(35바이트)다 |
| W9F3 F3 RV-07 x-peaket-scopes 값이 이상하면 authKindOf가 문제를 돌린다 | `tools/ci/gateway-routes.test.mjs` | 실패 | 문자열 `'ticket:buy'`를 `{ kind: 'token' }`으로 읽는다(배열이 아니면 조용히 버림) |
| W9F3 F3 RV-07 그런 작업이 하나라도 있으면 CLI가 2로 멈추고 … | 같은 파일 | 실패 | 문자열 스코프 작업이 있어도 생성기 문제 목록이 비어 그대로 쓴다 |
| W9F3 F4 칸막이가 찼을 때 429는 연결을 닫고 남은 본문을 읽지 않는다 | platform `test/body-limit.test.ts` | 실패 | ① 머리만 요청의 429가 `connection: keep-alive`다(서버가 본문을 기다리며 연결을 쥔다) |
| W9F3 F4 본문 상한 413도 연결을 닫는다(회귀) | 같은 파일 | **처음부터 통과** | Fastify 해석기 오류 길(`onDone`)이 `connection: close`를 단다. 아래 '처음부터 통과' 처리 |
| W9F3 F4 정상 요청은 연결을 다시 쓴다 | 같은 파일 | **처음부터 통과** | 과한 고침(M-F4b) 막기라 지금 통과가 맞다. 아래 처리 |
| W9F3 F5 신원 없는 요청은 칸막이 자리를 쥐지 못하고 본문을 기다리지 않는다 | platform 새 `test/bulkhead-auth.test.ts` | 실패 | 신원 없는 요청이 onRequest에서 자리를 잡고 본문을 기다려 1.5초 안에 답이 없다 |
| W9F3 F5 앞 판정은 가드와 같은 거절을 자리 잡기 전에 낸다 | 같은 파일 | 실패 | 자리가 찬 때 대상 틀림(`x-user-aud: fan`) 요청이 401이 아니라 429다(첫 줄에서 멈춤) |
| W9F3 F5 옳은 신원은 지금처럼 처리되고 identity는 캐시로 한 번만 묻는다 | 같은 파일 | **처음부터 통과** | 지금 동작을 지키는 대조 시험이다. 아래 처리 |
| W9F3 F5 칸막이 경로의 허용 역할이 클래스에만 있으면 서비스가 시작하지 않는다 | 같은 파일 | 실패 | `v1/bh-class/bulkhead` 서비스가 그대로 시작한다 |
| W9F3 F5 core 좌석맵 저장은 신원 없이 칸막이를 쥐지 못한다 | core 새 `test/partner-bulkhead-auth.test.ts` | 실패 | 신원 없는 머리만 요청이 자리를 잡고 본문을 기다려 1.5초 안에 답이 없다 |
| W9F3 F6 SR-T17 빗금·밑줄·쉼표·역빗금·가운뎃점으로 이은 번호도 가린다 | core `test/search-log.test.ts` | 실패 | `010/1234/5678`이 그대로 남는다(빗금이 구분자가 아니다) |
| W9F3 F6 SR-T17 정규화 뒤 가리기: 전각 빗금 번호도 로그에 남지 않는다 | core `test/search.http.test.ts` | 실패 | `search_query` 줄에 `010/1234/5678`이 그대로 남는다 |

- **처음부터 통과한 셋의 처리**(틀린 구현을 손으로 넣어 실패를 보고 되돌렸다, 트리에 남기지 않음):
  - F4 413 회귀: '오류 답에서 `connection` 머리를 떼어 내는 onSend 훅'(본문 전 413을 Fastify 해석기 길 밖에서 직접 낼 때 닫기를 빠뜨린 경우와 같은 꼴)을 `installRequestChecks`에 넣자 실패(`multipart 선언 길이 넘침(머리만): Connection: expected undefined to be 'close'`).
  - F4 정상 요청: M-F4b(모든 응답에 `connection: close`)를 넣자 실패(`/v1/limit/default 1번째: Connection: expected 'close' not to be 'close'`).
  - F5 옳은 신원: 가드가 `authz.tenantId`를 `Principal`에 넣지 않게 하자 실패(처리기가 받은 요청자의 테넌트가 비었다).
- **시험이 맞는지 임시 구현으로도 돌려 봄**(시험 담당이 저장소 밖에서 잠깐 넣고 모두 되돌림, 커밋에 없다. 구현 담당은 이것을 쓰지 않는다): F1(core와 같은 꼴 SQL 한 번, main.ts에서 조건 아래 부름)·F4(429 길에 `connection: close`)·F5(처리기 `@Roles`를 경로 설정에도 적고 칸막이 훅 앞에서 신원 판정, 실패 시 `connection: close`)로 위 시험이 모두 통과했고, 틀린 구현 표본 M-F1a·M-F1b·M-F1c·M-F4a·M-F4b·M-F5a(platform·core 둘 다)·M-F5b·M-F5c가 각각 잡혔다. 같은 F5 임시 구현에서 purchase-svc 회귀 넷(`write-bulkhead`·`orders-http`·`accept-http`·`order-identity`, 127개)과 core의 칸막이·429 시험(`review.http`·`sale-eligibility.http`), platform `body-limit`(public 칸막이)이 그대로 통과해, §3 F5의 '신원 머리 없이 429를 기대하는 기존 시험'은 없어 머리를 달지 않았다.
- **이 묶음과 무관하게 처음부터 실패하는 것**: `tools/ci/gateway-routes.test.mjs`의 기존 시험 'D-T42 ①② 저장소의 생성 파일이 지금 openapi와 원천으로 다시 만든 것과 같다'와 `node tools/ci/gateway-routes.mjs --check`가 출발점 `b165df27` 그대로(시험 담당 변경 없이 `git archive`로 뽑은 트리)에서도 1로 끝난다. 다섯 생성 파일의 계약 sha256 줄이 지금 openapi와 다르다(생성 파일 마지막 갱신 `e826ac8b` 뒤에 openapi가 `bca7f8a8`에서 바뀌었다). 구현 담당이나 감독이 `--write`로 다시 만들지 정한다.
- **시험이 정한 약속(정본·계획이 정하지 않은 세부, 바꾸려면 '시험 이의')**:
  - F1 통합: 슈퍼유저·표 소유자 까닭 글 `/행 보안/`, ops_app만 `/ops_partner/`, 둘 다 `/ops_app/`(계획), BYPASSRLS는 `/BYPASSRLS|슈퍼유저|행 보안/`, 소유 역할 구성원은 `/소유|행 보안/`(core와 같은 꼴이라고 본 너그러운 꼴). 소유 역할 구성원 줄은 표 소유자를 잠시 다른 역할로 옮겼다가 되돌린다.
  - F1 조립: 계획의 'main.ts 글에서' 대신 main.ts를 실제로 띄워(바깥 연결 가짜) `assertOpsPartnerRole` 부름과 차례(`createService`보다 앞)를 본다. 운영 환경은 감사 서명 키 등 다른 필수 값 때문에 main.ts를 띄우지 않고 조건 함수로만 본다. 역할 검사 모듈은 `src/adapters/db/database-role.js` 경로로 가짜를 단다(계획 §3 경로).
  - F2: `timingSafeEqual` 두 인자 차례는 [SHA-256(받은 값), SHA-256(기대 값)]. 받은 값이 빈 문자열이어도 가드가 한 번 견준다.
  - F3: 까닭 글에 `x-peaket-scopes`와 값이 든다. 값은 JSON 꼴로 본다(null → `null`, 빈 배열 → `[]`, 문자열 원소는 그 글자 그대로).
  - F4: 흘려보내기 사례는 첫 덩어리 뒤 응답을 받은 다음 나머지를 보낸다(서버가 닫은 뒤 보내면 손님이 응답 대신 끊김을 볼 수 있어서, 정본이 받아들인 것). 413의 JSON Problem은 지금 inject 응답과 같은 type이면 된다.
  - F5: '본문 해석 0'은 해석기 부름을 세지 않고 '머리만 보낸 요청이 본문 없이 답을 받는다'로 본다. '자리 0'은 옳은 요청이 머리만 보내 자리를 먼저 쥔 동안 거절 요청이 429가 아니라 제 거절을 받는지로 본다. 클래스에만 단 허용 역할의 시작 실패 까닭 글에는 경로 `v1/bh-class/bulkhead`(앞 빗금 없이)가 든다.
- **더한 뼈대**(동작 없음, 구현 담당이 채운다): `packages/platform/src/secret-compare.ts`(`constantTimeEqual`은 늘 false, `index.ts` 내보내기는 하지 않음), `services/ops-svc/src/adapters/db/database-role.ts`(`assertOpsPartnerRole`은 아무것도 하지 않음), `services/ops-svc/src/event-cancellation-wiring.ts`의 `partnerRoleCheckRequired`(늘 false). 시험 도우미 `packages/platform/test/raw-http.ts`(실제 소켓 HTTP/1.1, 서버 쪽 소켓 `bytesRead`)를 더했다.
- **형 검사·린트**: platform·core·ops `tsc -p tsconfig.json --noEmit` 0, 바꾼 src 파일 eslint 오류 0.

## 시험 이의

구현 담당 `w9f3-impl`(claude-opus-5-5), 2026-11-17. 시험 이의는 없다(17개 시험을 고치지 않고 모두 통과시켰다). 아래는 정본이 정하지 않아 구현이 정한 것과 계획·정본이 다른 한 곳이다(시험과는 부딪히지 않는다, 리뷰·계획이 볼 것).

- **정본과 다른 점(계획 판단 필요)**: 계획 §2 F5는 '허용 역할에 `public`이 있으면 ①을 건너뛴다'인데 정본 docs/api/guidelines.md §7 '본문을 읽기 전의 차례'는 '허용 역할이 `public`뿐인 경로는 ①이 없다'다. 정본대로 했다. ①은 공용 가드 앞부분과 같은 판정 함수(`judgeIdentity`)라 `[public, fan]` 같은 경로는 가드처럼 신원 머리가 없으면 익명으로 넘기고 있으면 본다. 지금 그런 칸막이 경로는 없다.
- (참고, 이의 아님) **기기 증명만 하는 스캐너 경로의 ①**: ①은 경로 설정의 허용 역할만 보고 기기 증명(`@ScannerAuth`)을 보지 못한다. 그래서 허용 역할에 `scanner_device`가 있으면 신원 머리 없는 요청을 ①에서 막지 않고 ④의 공용 가드·스캐너 가드에 맡긴다(가드보다 엄하게 거절하지 않는다). 지금 칸막이를 단 스캐너 경로는 없다.
- (참고, 이의 아님) **위험 작업(`@Roles(..., { fresh: true })`) 칸막이 경로**: 역할 캐시를 쓰지 않는 작업이라 ①과 ④가 identity를 한 번씩 묻는다(두 번). 지금 그런 칸막이 경로는 없다.
- (참고, 이의 아님) **'본문을 다 읽기 전'의 판정(F4)**: 칸막이 훅의 거절(429·①의 401·403·503)은 훅이 `Connection: close`를 직접 단다. 그 밖의 오류 답(해석기의 413·415 등)은 `installRequestChecks`가 거는 onSend 하나가 '상태 400 이상이고, 본문이 오는 요청(Content-Length가 0보다 크거나 chunked)인데 소켓이 본문 끝을 받지 못했고(`complete`) 다 읽지도 않았다(`readableEnded`)'이면 단다. 그래서 multipart 413 두 길도 Fastify 해석기 길(`onDone`)에 기대지 않는다. 정상 응답과 본문을 다 받은 뒤의 오류 답은 keep-alive 그대로다.
- (참고, 이의 아님) **`installRequestChecks`를 부르는 곳**: 서비스 코드에는 없다(`grep -r installRequestChecks services`가 비었다). 부르는 곳은 platform `src/service.ts`(`createService`, 가드와 같은 `AuthState`를 넘긴다)와 성능 비교 벤치 `bench/vt41/src/main.ts`(칸막이 경로가 없어 빈 `AuthState`)뿐이라 둘을 고쳤다.
- (참고, 이의 아님) **라우트 생성 파일 다시 만들기(감독 결정)**: F3 뒤 `node tools/ci/gateway-routes.mjs --write`로 다섯 파일을 다시 만들었다. 바뀐 것은 파일마다 둘째 줄 '계약 sha256'(`720ff10b…` → `7ef1b0bd…`)뿐이고 새로 생기거나 사라진 경로·메서드는 없다(openapi `bca7f8a8`의 변경은 응답 설명이라 라우트가 같다). 지금 openapi에는 F3 검사에 걸려 생성기가 멈추는 `x-peaket-scopes` 값이 없다.
- (참고, 이의 아님) **이 묶음과 무관하게 처음부터 실패하는 단위 시험**: platform `test/problem-types.test.ts`의 'PRF192_서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드와 제목이 같다'가 출발점 트리(이 묶음 변경을 치운 상태)에서도 실패한다. ops-svc `event-cancelled`의 제목 '회차 취소가 확정된 회차는 판매를 재개할 수 없습니다'가 목록의 제목과 다르다. 이 묶음 범위 밖이라 고치지 않았다.

## 리뷰

리뷰 담당 `w9f3-review`(claude-opus-5-5), 2026-11-17, 가지 끝 `92efe01b`(출발점 `9199a3de` = 지금 `origin/develop`, 그 뒤 develop에 openapi·deploy·platform 변경 없음). `git diff origin/develop...HEAD`로 읽고, 다시 돌린 것: platform `body-limit`·`bulkhead-auth`·`internal-token-constant-time`·`internal-token`(23 통과)·`problem-types`(2 통과), core `internal-sale-config-token-boot`·`partner-bulkhead-auth`·`search-log`·`search.http`(24 통과), ops `event-cancellation-main-wiring`(2 통과), `node --test tools/ci/gateway-routes.test.mjs`(41 통과), `node tools/ci/gateway-routes.mjs --check` 0, platform·ops `tsc --noEmit` 0. 통합(ops rls)은 Docker 잠금이 필요해 다시 돌리지 않았다(구현 담당 보고 10 통과).

### 지적마다 판정

| # | 판정 | 본 것 |
| --- | --- | --- |
| F1 | 맞음 | `assertOpsPartnerRole`(services/ops-svc/src/adapters/db/database-role.ts)의 SQL 한 번이 네 조건을 본다: ① `pg_has_role(current_user,'ops_partner','member')` ② `ops_app` 겸함 ③ `rolsuper or rolbypassrls`(역할 속성은 물려받지 않아 current_user만 보면 된다) ④ `event_cancellation_request`의 `relowner`에 대한 `pg_has_role(..., 'member')`(소유 역할 구성원 포함). 슈퍼유저는 `pg_has_role`이 모두 참이라 ③을 먼저 보는 차례가 맞다. 없는 역할 이름이면 SQL이 오류라 닫힌 쪽으로 실패한다. main.ts는 `partnerDatabase`를 만든 바로 뒤, `createService`·소비자 시작 전에 최상위 await로 부르고, `partnerUrl === url`로 건너뛰지 않는다. 조건은 `has(PEAKET_PARTNER_DATABASE_URL)`(공백만이면 없음)로 정본 authz-matrix §5.3 '시작 검사'와 같다. 경고 조건도 `!partnerRoleChecked`로 바뀌어 주소를 관제 주소와 같게 넣은 경우 경고 대신 검사한다 |
| F2 | 맞음 | `constantTimeEqual`(packages/platform/src/secret-compare.ts)은 두 값을 SHA-256(utf8) 32바이트로 줄여 `timingSafeEqual` 한 번, 기대 값 빈 문자열은 비교 뒤 false. 두 `sameSecret`이 모두 지워졌고 HTTP `InternalTokenGuard`(core `InternalToken401Guard`가 물려받음)·gRPC 인터셉터·`verifyInternalGrpcActor`의 토큰과 처리자 증명 세 자리가 모두 바뀌었다. gRPC의 `caller`·`actor` 이름 비교(`!==`)는 비밀이 아니다. 짧은 grep으로 남은 비밀 `===`/길이 먼저 비교를 찾았다: 남은 `length !== … \|\| timingSafeEqual`은 모두 길이가 공개인 고정 길이 값(멱등 키 해시·HMAC 요약·쿠키 서명, 계획 §1 범위 밖과 같다)이고, 메모리 어댑터(시험용)의 `===`뿐이다. 하나만 아래 새 지적 N3 |
| F3 | 맞음 | `scopesProblemOf`(tools/ci/gateway-routes.mjs)는 칸이 있을 때만(`hasOwnProperty`) 보고, 배열 아님(null·문자열)·빈 배열·문자열 아닌 원소·모르는 값(대소문자·공백 다름)·중복을 문제로 돌린다. 그 뒤 `ticket:buy`인데 갈래 하나라도 액세스 토큰이 없거나 `security: []`이면 문제다. 칸이 없으면 옛 흐름 그대로라 너무 넓지 않고, 계획 §2 목록보다 좁지도 않다. 다시 만든 생성 파일 다섯은 파일마다 둘째 줄 계약 sha256 한 줄만 바뀌었다(5 insertions, 5 deletions) |
| F4 | 맞음(낮음 하나) | 칸막이 훅의 거절(429와 ①의 401·403·503)은 `rejectBeforeBody`가 `Connection: close`를 달고, 그 밖의 오류 답은 전역 onSend가 '상태 ≥ 400이고 본문이 오는 요청인데 소켓이 다 받지도(`complete`) 다 읽지도(`readableEnded`) 않음'일 때만 단다. 정상 응답과 본문을 다 읽은 뒤의 오류(가드 401·검사 400 등)는 keep-alive 그대로라 M-F4b(모든 응답 닫기)에 걸리지 않는다(정상 요청 재사용 시험도 통과). HTTP/2를 쓰지 않아(`connection` 머리가 h2에서 금지되는 문제 없음) 안전하다. 칸막이 훅만 조건 없이 닫는 점은 N2 |
| F5 | 맞음(낮음 둘) | 아래 보안 점검 |
| F6 | 맞음 | `MASK_SEPS`에 `/`·`\`·`_`·`,`·`·`(U+00B7)를 더하고 하이픈·점·공백·괄호와 상한 3은 그대로. 정본 search.md §11과 같다 |
| PRF192 | 맞음 | ops `event-cancelled`의 제목을 openapi 목록 '취소가 확정된 회차입니다'(purchase와 같음)로 맞추고 옛 문장은 `detail`로 옮겼다. ops 시험은 `slug`·상태만 보고, 관제 화면의 '재개할 수 없는 회차'는 화면 고정 문구라 영향이 없다. `problem-types` 시험 통과. 범위 밖이라 했던 §'시험 이의' 마지막 줄과 달리 고쳤으나, 작은 맞춤이라 받아들인다 |

### F5 보안 점검

- **우회 길**: 없다. 앞 판정(①)은 거절을 더할 뿐이고 통과해도 본문 뒤 공용 가드 전체(④)가 그대로 돈다. 가드는 여전히 `ROLES_METADATA`를 처리기 → 클래스 차례로 읽고, 경로 설정의 `ROUTE_ROLES_KEY`는 처리기에 단 같은 `policy` 객체라 둘이 다를 수 없다. `@Bulkhead`·`@BodyLimit`·`@AcceptMultipart`·`@Roles`는 모두 경로 설정을 `{ ...prev }`로 합쳐 쓰므로 데코레이터 차례와 상관없이 칸이 남고, 서비스 코드에 Nest `@RouteConfig`(덮어쓰기)는 없다. 지금 칸막이 경로 여덟(core 넷, purchase 넷)은 모두 처리기에 `@Roles`가 있다.
- **① 건너뛰기 조건**: `publicOnly`(허용 역할이 모두 `public`)일 때만 건너뛴다. 정본 guidelines §7 '`public`뿐인 경로는 ①이 없다'와 같다. 계획 §2 F5의 '`public`이 있으면'은 정본과 다르고 정본이 이긴다(구현 판단이 맞다). `[public, fan]`이면 `judgeIdentity`가 가드와 같이 신원 머리가 없을 때만 익명 통과다.
- **판정이 같은가**: `AuthGuard`와 `admitBeforeBody`가 `judgeIdentity` 한 함수를 쓴다. 가드 리팩터링 전후 차례(공개 → 신원 → 종료 세션 → 대상 → 스코프 → identity 세션 → 비밀번호 바꾸기 → 역할, 익명 통과 때 검사 실패만)가 같음을 한 줄씩 대조했다. 다른 곳은 `deviceOnly` 하나다: 가드는 `@ScannerAuth`가 있고 `token !== 'required'`이며 `scanner_device`를 허용할 때, 앞 판정은 `scanner_device`를 허용하기만 하면 참이다. 앞 판정이 더 너그러운 쪽이라 우회는 아니다(N1).
- **응답 꼴·연결 닫기**: 훅 오류는 Nest가 Fastify 오류 처리기로 거는 전역 `ProblemFilter`를 지나므로 가드와 같은 Problem 꼴이다. 401은 `rejectBeforeBody`가 가드와 같은 `WWW-Authenticate: Cookie realm="peaket"`를 달고, 503 `authz-unavailable`(Retry-After 1)·403 `password-change-required`·429 `server-busy`(Retry-After)도 같은 오류 객체다. 모두 `Connection: close`. 시험이 401·403·503의 type·머리·닫힘·처리기 0을 본다.
- **자리 놓기**: `held`가 참일 때만 놓으므로 ①에서 거절된 요청이 남의 자리를 줄이지 않는다. 판정을 기다리는 동안 끊긴 요청도 close 수신기를 판정 전에 걸어 놓쳐지지 않는다(그 뒤 `take`로 잡힌 자리는 옛 흐름처럼 onSend → `handled`에서 놓는다).
- **identity 캐시·fresh**: 앞 판정이 `adminAuthzOf(..., fresh)`로 캐시를 채우고 가드는 5초 안이면 캐시를 쓴다(시험: 부름 1). 본문이 5초보다 오래 걸리면 가드가 다시 묻고, 종료 세션 목록도 가드가 다시 보므로 옛 보장보다 약해지지 않는다. `valid: false`는 캐시하지 않는다. `fresh: true` 칸막이 경로는 두 번 묻는다(지금 없음, 구현 기록대로).
- **시작 실패**: 칸막이 경로에 경로 설정 정책이 없으면 onRoute에서 던져 `app.init`이 실패한다(클래스에만 단 `@Roles`, 시험 통과). `@Roles`가 아예 없으면 옛 AZ-T1 시작 검사가 막는다.

### 새 지적

| # | 등급 | 파일:줄 | 내용 | 권고 |
| --- | --- | --- | --- | --- |
| N1 | 낮음 | packages/platform/src/auth.ts:398 | `admitBeforeBody`의 `deviceOnly`가 `scanner_device` 허용만 보고 `@ScannerAuth` 유무·`token: 'required'`를 보지 않아 가드(auth.ts:422)보다 너그럽다. 예를 들어 `[scanner_device, ops_admin]`에 `@ScannerAuth({ token: 'required' })`를 단 칸막이 경로가 생기면 신원 없는 요청이 자리를 잡고 본문을 읽은 뒤 가드에서 401이다(우회 아님, '자리 0' 보장만 빈다). 지금 그런 경로는 없다 | 정리 목록. 시작 때 칸막이 경로가 `scanner_device`를 허용하면 막거나, `@ScannerAuth` 옵션도 경로 설정에 적어 가드와 같은 식으로 본다 |
| N2 | 낮음 | packages/platform/src/request-checks.ts:392-393, :465 | 칸막이 훅의 거절은 본문이 이미 다 왔거나 없어도 늘 `Connection: close`다(전역 onSend는 `bodyPending`으로 가른다, :479). 정본 guidelines §7이 '칸막이 429'를 닫는 길로 적었으니 정본대로다. 다만 purchase 쓰기 칸막이(작은 JSON 본문, 과부하 때 429로 덜어 내는 핫패스)에서 과부하마다 게이트웨이 → 파드 연결을 끊고 다시 열게 되어, 가장 바쁠 때 연결 맺기 비용이 늘 수 있다. 측정하지 않았다 | 검증·성능 담당이 볼 것. 바꾼다면 정본 문장을 '본문이 남았으면'으로 좁히고 훅에서도 `bodyPending`을 쓴다(F4 시험 ①~③은 모두 본문이 남은 경우라 그대로 통과할 것) |
| N3 | 낮음 | services/pg-simulator/src/server.ts:59 | 시뮬레이터의 `authorization` 비교가 옛 꼴(길이 먼저 비교)이다. local·CI용이라 운영 위험은 없다 | 정리 목록(원하면 `constantTimeEqual`로) |
| N4 | 낮음 | packages/platform/src/request-checks.ts:465 | ①이 ②보다 앞이라, 칸막이가 찬 때에도 관리 대상 요청마다 identity를 부른다(옛 흐름은 찬 때 identity 없이 429). 게이트웨이를 거치지 않는 위조 머리(세션 ID를 바꿔 가며)로 identity 부름을 늘릴 수 있다. 정본이 정한 차례의 대가이고 1초 시간 초과·5초 캐시가 있다 | 기록만. identity 쪽 부하 한도가 이 길도 덮는지 정리 목록에서 확인 |

- 높음·중간은 없다.

### 시험 경계

- 구현 커밋 `32df9b52`·`714f8414`·`5c90986e`·`3199cd37`·`2fbbe2d4`·`92efe01b`는 `test/`·`test-int/`·`*.test.*`·`raw-http.ts`를 건드리지 않았다(파일 목록 대조).
- 시험 커밋 `0c8d8b62`의 제품 코드 변경은 뼈대 셋뿐이다: `secret-compare.ts`(늘 false), ops `database-role.ts`(빈 함수), `partnerRoleCheckRequired`(늘 false). 동작이 없고 '실패 확인'에 적힌 대로다.

### 합쳐도 되나

합쳐도 된다. 새 지적 넷은 모두 낮음이라 막지 않고 정리 목록으로 넘긴다(N2는 검증·성능 담당이 한 번 본다). 통합 ops rls는 검증 때 다시 돌린다.

## 검증

검증 담당 `w9f3-verify`(claude-opus-5-5), 2026-11-17, 가지 끝 `13583e44`. 이 묶음의 계획·시험·구현·리뷰는 맡지 않았다. 변이는 저장소 밖 스크립트(scratchpad `w9f3-verify/mutate.mjs`)로 하나씩 넣고 닿는 시험을 돌린 뒤 원래 내용으로 되돌렸다. 단위는 패키지·서비스 폴더에서 vitest(모두 `@peaket/platform`을 원본 `src`로 잇는 설정이라 platform 다시 빌드는 필요 없었다), tools는 `node --test`, F1 통합은 Docker 잠금(`D:/ticketpass-locks/docker`, 18:20~18:24)을 잡고 `vitest.integration.config.mjs`로 돌렸다(컨테이너 접두 `w9f3-verify-`, 끝난 뒤 남은 컨테이너 0, 잠금 지움).

### 셈

- 기준선: platform 24·core 24·ops 2·tools 41 통과, ops 통합(rls) 10 통과, purchase 회귀 넷(`write-bulkhead`·`orders-http`·`accept-http`·`order-identity`) 127 통과.
- 넣은 변이 **31개**(계획 §5의 14 + 검증 담당이 더한 17): **잡힘 24, 살아남음 7**. 계획 14개 가운데 13개가 잡혔고 M-F4a 하나가 살아남았다(등가, 아래). 권한·보안 변이(F1·F2·F3·F5) 26개 가운데 살아남은 것은 셋(V-F2f·V-F5f·V-F5g)이다.

### 변이 표

시험 묶음: P = platform `body-limit`·`bulkhead-auth`·`internal-token-constant-time`·`internal-token`·`internal-token-boot`, C = core `internal-sale-config-token-boot`·`partner-bulkhead-auth`·`search-log`·`search.http`, O = ops `event-cancellation-main-wiring`, I = ops 통합 `event-cancellation-rls`, T = `tools/ci/gateway-routes.test.mjs`, G = platform `grpc-channel`.

| # | 위치 | 꼴 | 결과(잡은 시험) |
| --- | --- | --- | --- |
| M-F1a | services/ops-svc/src/main.ts:36 | 시작 검사 호출을 뺌 | 잡힘: O 'W9F3 F1 파트너 DB 주소가 있으면 … 역할 검사를 부른다' |
| M-F1b | services/ops-svc/src/adapters/db/database-role.ts:30 | 소유자 검사를 뺌 | 잡힘: I 'W9F3 F1 … 시작 때 본다'(:208 소유 역할 구성원 줄. 표 소유자 줄은 슈퍼유저라 특권 검사가 먼저 잡는다) |
| M-F1c | main.ts:36 | `&& partnerUrl !== url`(같은 풀이면 건너뜀) | 잡힘: O 같은 시험(같은 주소 줄) |
| M-F2a | packages/platform/src/secret-compare.ts:9 | 해시 전에 바이트 길이로 일찍 끝냄 | 잡힘: P ⑤·P gRPC·C ④ |
| M-F2b | packages/platform/src/internal-grpc.ts:6 | gRPC 세 자리를 옛 `sameSecret`(길이 먼저)으로 | 잡힘: P 'W9F3 F2 내부 gRPC 토큰·처리자 증명도 공용 비교를 쓴다' |
| M-F3a | tools/ci/gateway-routes.mjs:57 | 모르는 스코프 검사를 뺌 | 잡힘: T authKindOf·T CLI |
| M-F3b | gateway-routes.mjs:54·73 | 배열이 아니면 문제 없이 `[]`로 봄 | 잡힘: T authKindOf·T CLI |
| M-F3c | gateway-routes.mjs:79 | `ticket:buy`인데 token 아님 검사를 뺌 | 잡힘: T authKindOf·T CLI |
| M-F4a | packages/platform/src/request-checks.ts:393 | 칸막이 훅 거절에서 선언 길이가 있을 때만 `Connection: close` | **살아남음**(등가): 전역 onSend(:479)가 chunked 429에도 `bodyPending`으로 닫는다. 두 겹을 함께 깨면(V-F4f) 잡힌다 |
| M-F4b | request-checks.ts:479 | 모든 응답에 `Connection: close` | 잡힘: P 'W9F3 F4 정상 요청은 연결을 다시 쓴다' |
| M-F5a | request-checks.ts:465 | ① 신원 판정 없이 바로 자리(옛 차례) | 잡힘: P F5 신원 없음·P F5 앞 판정·C F5 core 좌석맵 |
| M-F5b | packages/platform/src/auth.ts:375·398 | 앞 판정은 머리만 보고 identity 세션 판정·역할을 건너뜀 | 잡힘: P F5 앞 판정 |
| M-F5c | auth.ts:373·398 | 앞 판정에서 대상(aud) 검사를 뺌 | 잡힘: P F5 앞 판정 |
| M-F6a | services/core-svc/src/modules/catalog/domain/search.ts:878 | 구분자에 `/`만 더함 | 잡힘: C 'W9F3 F6 SR-T17 빗금·밑줄·…' |
| V-F1d | database-role.ts:29 | 슈퍼유저·BYPASSRLS 검사를 뺌 | 잡힘: I(:202 BYPASSRLS 줄) |
| V-F1e | database-role.ts:26 | 소유자 판정을 '직접 소유자'로 좁힘(소유 역할 구성원 빠짐) | 잡힘: I(:208) |
| V-F1f | services/ops-svc/src/event-cancellation-wiring.ts:49 | 빈 문자열 주소도 '있음'으로 봄 | 잡힘: O(빈 값 줄) |
| V-F1g | database-role.ts:32 | `ops_app` 겸함 검사를 뺌 | 잡힘: I(:200 둘 다 줄) |
| V-F2c | secret-compare.ts:12 | 기대 값 빈 문자열 거절을 뺌 | 잡힘: P ⑤(`constantTimeEqual('', '')`) |
| V-F2d | secret-compare.ts:10 | `timingSafeEqual` 대신 `===` | 잡힘: P ⑤·P gRPC·C ④ |
| V-F2e | auth.ts:28 | HTTP 가드만 옛 `sameSecret`(gRPC는 새 것) | 잡힘: P ⑤·C ④ |
| V-F2f | internal-grpc.ts:67 | gRPC 서버 인터셉터의 토큰 비교만 `===` | **살아남음**: P·C·G 모두 통과. 인터셉터 비교를 엿보는 시험이 없다(`grpc-channel` 시험은 맞음·틀림 결과만 본다) |
| V-F3d | gateway-routes.mjs:78 | `sec.length > 0` 조건을 뺌(`security: []`이 token) | 잡힘: T authKindOf(`security: []` 줄) |
| V-F4c | request-checks.ts:479 | 전역 onSend가 본문 상태와 상관없이 오류 답(400 이상)을 모두 닫음 | **살아남음**: 본문을 다 읽은 뒤 오류 답(가드 401·검사 400 등)이 keep-alive인지 보는 시험이 없다 |
| V-F4d | request-checks.ts:393 | 칸막이 훅 거절의 `Connection: close`를 뺌 | **살아남음**(등가): 시험 사례는 모두 본문이 남은 요청이라 전역 onSend가 닫는다 |
| V-F4e | request-checks.ts:479 | 전역 onSend를 뺌 | **살아남음**(등가): 413은 Fastify 해석기 길(`onDone`)이 닫고, 429·①은 훅이 닫는다 |
| V-F4f | request-checks.ts:393·479 | M-F4a + 전역 onSend를 뺌 | 잡힘: P F4 429(:251 ③ chunked가 2초 안에 닫히지 않음) |
| V-F5d | request-checks.ts:465 | 차례를 바꿈(② 자리 → ① 신원) | 잡힘: P F5 신원 없음·P F5 앞 판정·C F5 core 좌석맵 |
| V-F5e | request-checks.ts:434 | 놓기에서 `held` 조건을 뺌(①에서 거절된 요청도 자리를 놓음) | 잡힘: P F5 둘·P F4 셋·P HOT240·C F5 core |
| V-F5f | request-checks.ts:427 | ① 건너뛰기를 '`public`이 있으면'으로 넓힘(계획 §2 문구) | **살아남음**: `[public, …]` 칸막이 경로를 쓰는 시험이 없다(지금 그런 경로도 없다) |
| V-F5g | auth.ts:379·398 | 앞 판정에서만 비밀번호 바꾸기 필요 세션 403을 건너뜀 | **살아남음**: F5 앞 판정 사례에 `password:change` 세션 줄이 없다 |

### 살아남은 것과 처리 제안

| # | 판단 | 제안 |
| --- | --- | --- |
| M-F4a·V-F4d·V-F4e | 등가(두 겹 가운데 한 겹만 깬 것). 칸막이 훅의 닫기와 전역 onSend의 닫기가 서로를 덮고, 413은 지금 Fastify 5.12.7 해석기도 닫는다. 정본 동작은 지켜진다 | 받아들인다. 다만 V-F4d가 살아남는 것은, 리뷰 N2(칸막이 훅이 본문이 없어도 늘 닫음)를 고칠 때 훅의 닫기를 빼고 전역 onSend(`bodyPending`)에 맡겨도 F4·F5 시험이 그대로 통과한다는 뜻이다(N2를 정리 목록에서 다룰 때 참고). 구현 기록의 'multipart 413 두 길도 Fastify에 기대지 않는다'는 V-F4e가 살아남아 시험으로 묶여 있지 않다(Fastify가 바뀔 때만 의미가 있다, 정리 목록 낮음) |
| V-F2f | 시험 빈 곳(낮음~중간). 인터셉터(`grpc-channel.ts`가 모든 내부 gRPC 서버에 거는 토큰 검사)가 상수 시간 비교를 쓰는지 아무 시험도 보지 않는다. 지금 구현은 맞다 | 정리 목록: `internal-token-constant-time.test.ts`의 gRPC 시험에 `internalGrpcServerInterceptor`를 한 번 태워 `timingSafeEqual` 1번·32바이트 인자를 보는 줄을 더한다(시험 담당 몫, 이 묶음을 막지 않음) |
| V-F5g | 시험 빈 곳(낮음). 정본 ①에 '비밀번호 바꾸기 필요 세션'이 있으나 F5 앞 판정 사례에 없다. 판정 함수가 가드와 하나(`judgeIdentity`)라 갈라질 위험은 작다 | 정리 목록: F5 앞 판정 표에 `password:change` 스코프 partner 세션 → 403 `password-change-required`·자리 0 줄 하나 |
| V-F5f | 시험 빈 곳(낮음). 정본 '`public`뿐인 경로는 ①이 없다'와 계획 '`public`이 있으면' 사이를 가르는 시험이 없다. 구현은 정본대로다 | 정리 목록: `[public, fan]` 칸막이 경로 하나에 대상이 틀린 신원 요청 → 401·자리 0 줄. 또는 그런 경로가 생기기 전까지 받아들인다 |
| V-F4c | 시험 빈 곳(낮음, 과한 닫기). 정본은 '본문을 다 읽기 전'의 오류 답만 닫는다고 하고 그 밖의 오류 답은 말하지 않는다. 지금 구현은 keep-alive로 둔다 | 정리 목록: F4 정상 요청 시험에 '본문을 다 보낸 뒤 401(가드)·400(검사) 답에는 `connection: close`가 없다' 줄. N2와 함께 본다 |

### 판정 기준 대조

| 기준 문장(정본·계획) | 단언하는 시험 | 같은가 |
| --- | --- | --- |
| guidelines §7 차례 ① 신원 머리 셋 → 종료 세션 → 대상 → 스코프 → identity 세션·비밀번호 바꾸기 필요 세션·역할 | P F5 신원 없음(머리 없음 401), P F5 앞 판정(대상·종료 세션·`valid: false` 401, 던짐·시간 초과 503, 역할 403, 스코프 403) | 거의 같다. **비밀번호 바꾸기 필요 세션 줄이 없다**(V-F5g) |
| ① '역할 캐시는 그대로 쓴다' | P F5 옳은 신원(identity 부름 1) | 같다 |
| '①에서 막히면 가드와 같은 401·403·503이고 자리를 잡지 않고 본문을 읽지 않는다' | P F5 앞 판정(상태·type·WWW-Authenticate, 옳은 요청이 자리를 쥔 동안 제 거절, 머리만 보낸 요청이 본문 없이 답), C F5 core 좌석맵 | 같다('본문을 읽지 않음'은 bytesRead가 아니라 머리만 보낸 요청이 답을 받는 것으로 본다, 시험 약속대로) |
| '허용 역할이 `public`뿐인 경로는 ①이 없다' | P body-limit의 public 칸막이 시험(신원 없이 200·429) | 절반. '뿐'과 '있으면'을 가르는 줄이 없다(V-F5f) |
| '칸막이 경로의 허용 역할은 처리기에 단다(클래스에만 달면 서비스가 시작하지 않는다)' | P F5 클래스에만(`@Bulkhead`·`@BodyLimit` 둘, 까닭에 경로) | 같다 |
| ④ 공용 가드 전체(지금 차례 그대로) | purchase 회귀 넷 127, 기존 가드 시험 | 같다(회귀로 본다) |
| guidelines §7 '본문을 다 읽기 전에 오류로 답하는 모든 길(413·429·①의 401·403·503)은 `Connection: close`를 달고 응답을 다 보낸 뒤 연결을 닫는다' | P F4 429 ①②③, P F4 413 넷, P F5 두 시험(2초 안 닫힘) | 같다 |
| '닫은 뒤 더 읽는 양은 이미 받은 것뿐이다' | P F4 bytesRead ≤ 1MiB([가정] 시험 문턱) | 근사(문턱으로 본다, 계획 §7대로) |
| 계획 §2 F4 '정상 응답은 keep-alive 그대로' | P F4 정상 요청 | 같다. 본문을 다 읽은 뒤의 오류 답은 정본이 정하지 않았고 시험도 없다(V-F4c) |
| authz-matrix §5.3 시작 검사 '`PEAKET_PARTNER_DATABASE_URL`이 있으면(환경과 상관없이)' | O(production·ci·local, 관제와 같은 주소, 빈 값·없음 false, main.ts를 띄워 `createService`보다 앞) | 같다 |
| 같은 문장의 네 조건(`ops_partner`, `ops_app` 겸함 아님, 슈퍼유저·`BYPASSRLS` 아님, 표 소유자·소유 역할 구성원 아님) | I 'W9F3 F1 … 시작 때 본다' 여섯 줄 | 같다(조건마다 변이가 따로 잡힘: M-F1b·V-F1d·V-F1e·V-F1g) |
| '하나라도 어긋나면 까닭을 적고 시작하지 않는다' / '주소가 없으면 보지 않고 경고만' | I 까닭 글 정규식, O 차례·조건 함수 | 거의 같다. 경고 문구 자체는 단언하지 않는다(낮음, 기록만) |
| architecture §3.2 'REST' 행·asvs/settlement.md 11.2.4 'SHA-256으로 줄인 뒤 `timingSafeEqual`로 한 번, 길이가 달라도 일찍 끝내지 않음', 내부 gRPC 공유 토큰도 | P ⑤(같음·틀림·짧음·긺·빈 값·한글), C ④, P gRPC(`verifyInternalGrpcActor`의 토큰·처리자 증명) | 거의 같다. **gRPC 서버 인터셉터는 시험이 없다**(V-F2f) |
| infra §4.1 ④ 이상한 값(배열 아님·빈 배열·문자열 아닌 원소·모르는 값·중복·`ticket:buy`인데 token 아님) → 그 작업과 까닭을 한 줄로 보이고 2로 멈춤 | T authKindOf(목록의 모든 꼴), T CLI(끝 코드 2·까닭 줄·생성 파일 없음) | 같다 |
| infra ④ 칸이 없으면 ①~③ 그대로 | T 대조 줄(칸 없음 → token, 기존 D-T42) | 같다 |
| search.md §11 구분자 아홉, 날짜·`1,000,000`도 `[숫자]`, 4자리 이하는 남음 | C search-log(구분자마다, `2026/11/17`·`1,000,000`, 남는 것 셋) | 같다 |
| search.md §11 '검색 자체는 가리기 전 값으로 한다' | C search.http(전각 빗금 번호, 결과가 가리기 전 값으로 찾은 것과 같음) | 같다 |

### 되돌림 확인

- 변이마다 실행기가 원래 내용을 다시 썼고, 끝난 뒤 `git status --short`가 비었다(`git diff --stat` 0). 되돌린 트리에서 platform 24·core 24·ops 2·tools 41을 다시 돌려 모두 통과했다.
- platform `dist`는 건드리지 않았다(닿는 시험이 모두 원본 `src`를 잇는다). Docker: `w9f3-verify-` 컨테이너 0, 잠금 폴더는 18:24에 지웠다(그 뒤 다른 묶음 담당이 새로 잡았다).
- 합쳐도 되나: 막을 것은 없다. 살아남은 7개 가운데 셋은 등가, 넷은 낮은 시험 빈 곳이라 정리 목록으로 넘긴다(V-F2f를 먼저).
