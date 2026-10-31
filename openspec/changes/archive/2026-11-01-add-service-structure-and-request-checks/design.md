# 설계: 서비스 안 구조·요청 검사·인증 가드·Drizzle 설정

## 맥락

정본이 정한 것:

- 서비스 안 구조: 바운디드 컨텍스트 하나가 NestJS 모듈 하나이고, 받는 층(REST·gRPC 처리기, Kafka 소비자) → 유스케이스 층 → 도메인 층(업무 규칙과 상태, 프레임워크·저장소를 모른다)으로 나눈다. 바깥 의존은 도메인이 정한 포트 뒤 어댑터다. 의존은 안쪽으로만 향하고, 서비스 템플릿이 폴더 뼈대를 주며, 층을 거꾸로 부르는 import는 공용 ESLint 설정(`no-restricted-imports`)이 막는다(docs/architecture.md §3.1, 기술 검토 낮음-008).
- 검사: 일반 경로는 계약 생성 Zod를 쓰는 Zod 파이프, 핫패스(대기열 진입·입장 확정, 좌석 홀드·해제·연장, 결제 접수)는 같은 Zod를 `z.toJSONSchema()`(요청 `io: "input"`, `target: "draft-07"`)로 바꾼 Fastify 경로 스키마다. `text/plain` 본문(대기열 두 경로)은 그 형식의 해석기가 JSON으로 읽고 스키마의 `content`에 `text/plain`을 둔다. 실패는 Problem 400. 두 검사가 같은 값을 받고 거르는지는 같은 표본 시험(V-T41의 표본 묶음)으로 본다(guidelines §1, ADR-0023, 기술 검토 낮음-001).
- 본문 형식: 본문이 있는 쓰기 요청은 `application/json`만, 대기열 진입·입장 확정만 `text/plain`도 받고 그 밖은 415(asvs/delivery.md 3.5.2, ADR-0065 결정 6).
- HTTP 파라미터 오염: 같은 이름의 매개변수가 겹쳐 오면 거부하고 출처(쿼리·본문·머리)를 구분해 받는다(asvs/delivery.md 15.3.7). 요청 스키마의 정의 밖 칸은 계약이 `additionalProperties: false`로 막는다(authz-matrix §4, 생성기가 `.strict()`로 옮긴다).
- 인증: 게이트웨이가 토큰을 검증하고 신원(`X-User-Id`·`X-Session-Id`·`X-User-Pid`·`X-User-Pid-Prev`, 권한 스코프)을 내부 헤더로 넘기며, 서비스는 토큰을 다시 검증하지 않는다. 서비스는 메모리의 종료 세션 목록(세션 종료 사건을 받아 15분 둔다)으로 끝난 세션을 수 초 안에 막는다(identity §3, ASVS 7.4.1). 역할은 토큰에 없고, `RolesGuard`가 처리기마다 적은 허용 역할(`x-peaket-roles`의 값)과 identity `GetAdminAuthz`(관리 계정)로 받은 지금 역할을 견준다. 5초 캐시, 세션 종료 사건에 지움, 위험 작업은 캐시 없이, 답이 없고 캐시에도 없으면 503 `authz-unavailable`. 허용 역할을 적지 않은 처리기가 있으면 시작하지 않는다(AZ-T1). 현장 스태프는 `CheckScannerSession`의 역할이다(ADR-0172, authz-matrix §5.2·§5.5). `valid=false`면 401(identity.proto).
- Drizzle: 0.45 계열 SQL형 빌더만(Relational Queries 안 씀), `drizzle-kit generate`의 SQL 파일이 스키마 원본(ADR-0037). 앱 풀은 node-postgres `pg.Pool`, `connectionTimeoutMillis` 핫패스 100ms·일반 1초, `idleTimeoutMillis` 10초, `maxLifetimeSeconds` 30분, 넘으면 기다리지 않고 429 `server-busy`와 `Retry-After`(architecture §5 '시간 초과 기본값', ADR-0070, 기술 검토 낮음-140). 연결 시작 매개변수의 `statement_timeout`·세션 `SET`은 쓰지 않고, 트랜잭션에만 걸 값은 첫 문장 `SET LOCAL`(ADR-0083). 파트너 경로 트랜잭션은 `SET LOCAL app.tenant_id`(authz-matrix §5.3).
- `@peaket/contracts`는 원본 `.ts`를 내보내고 모음 파일이 확장자 없이 다시 내보내 Node만으로는 못 읽는다. esbuild로 서비스를 묶으면 NestJS 생성자 주입의 데코레이터 메타데이터가 빠진다(R-221).

정본에 없는 작은 세부는 아래처럼 정했다(추천 적용 2026-11-01). 정본 문서에도 같은 날짜로 적는다.

## 결정

1. **서비스 안 구조 뼈대와 층 규칙**
   - 폴더: `src/main.ts`(시작), `src/app.module.ts`(뿌리), `src/modules/<컨텍스트>/<컨텍스트>.module.ts`(조립: 포트에 어댑터를 묶는다), 그 아래 `inbound/`(받는 층), `application/`(유스케이스), `domain/`(업무 규칙·상태와 포트 인터페이스), `adapters/`(포트 구현: 저장소·다른 서비스·외부 제공자). Drizzle 표 정의는 `adapters/db/schema.ts`, 마이그레이션 SQL은 `migrations/`, 설정은 `drizzle.config.ts`다.
   - 층 규칙(같은 서비스 안, import 문자열 기준): `domain`은 다른 층과 프레임워크·저장소 패키지(`@nestjs/*`·`fastify`·`drizzle-orm`·`pg`·`@peaket/platform`·`@peaket/contracts`)를 가져오지 않는다. `application`은 `domain`만 가져오고 `inbound`·`adapters`와 웹·저장소 패키지(`fastify`·`drizzle-orm`·`pg`·`@peaket/contracts`)를 가져오지 않는다(`@nestjs/common`의 주입 장식자와 `@peaket/platform`의 Problem·요청 맥락은 쓴다). `inbound`는 `adapters`를 가져오지 않는다. `adapters`는 `inbound`·`application`을 가져오지 않는다. 모듈 조립 파일과 `main.ts`는 모두 가져온다. 다른 컨텍스트의 층 폴더를 직접 가져오지 않는다(그 모듈의 공개 파일 `index.ts`로만).
   - 도구: ESLint 10 + `@typescript-eslint/parser` 8(형 정보 없이 구문만 읽는다). typescript-eslint 8.72가 TypeScript 6.1 미만만 지원해, 뿌리와 `packages/config`에 파서용 `typescript` 6.0.3을 둔다. 패키지들의 빌드·형 검사는 그대로 TypeScript 7이다. 규칙은 `@peaket/config/eslint/service-layers`, 뿌리 `eslint.config.mjs`가 `services/*/src/modules/**`와 `packages/platform/template/src/modules/**`에 건다. `pnpm lint`가 돌고 CI `ci-node`에 단계를 더한다.
   - 뼈대는 `packages/platform/template/`에 두고(서비스가 없으므로), 그 뼈대를 `createService`로 띄워 받는 층 → 유스케이스 → 도메인 → 포트 → 어댑터를 지나는 시험이 플랫폼 시험에 든다. 서비스는 이 폴더를 복사해 시작한다.

2. **HTTP 문자열 바꾸기**(쿼리·경로·머리, 두 검사 길이 같은 함수를 쓴다)
   - 기준은 그 부분의 JSON Schema다(Zod 파이프는 같은 Zod를 `z.toJSONSchema()`로 바꾼 것을 한 번 만들어 둔다). 칸의 형이 `integer`·`number`면 JSON 숫자 문법(`-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`)에 맞는 문자열만 숫자로, `boolean`이면 `true`·`false`만 불리언으로, `array`면 쉼표로 나눠 낱값마다 같은 규칙을 쓴다. 형이 여럿(`anyOf`·형 목록, null 허용)이면 문자열·숫자·불리언 순으로 처음 맞는 것을 쓴다. 맞지 않으면 문자열 그대로 두어 검사가 400을 낸다.
   - 머리: 들어온 이름(Node가 소문자로 바꾼다)을 스키마의 칸 이름과 대소문자 없이 맞춰 스키마의 이름으로 넘긴다(`Idempotency-Key`). 경로 스키마 쪽은 Fastify가 머리 칸 이름을 소문자로 바꾸므로 소문자다.
   - 같은 이름이 겹쳐 온 쿼리(`?a=1&a=2`)는 형과 관계없이 400이다(ASVS 15.3.7). 배열은 쉼표로 이어 보낸다(`?eventIds=a,b`).

3. **Zod 파이프**: 처리기 매개변수 장식자 `@ContractBody(스키마)`·`@ContractQuery(스키마)`·`@ContractParams(스키마)`·`@ContractHeaders(스키마)`. 결정 2를 한 뒤(머리만 계약의 칸을 골라 넘기고, 쿼리·경로는 모르는 키도 넘겨 닫은 스키마면 거절한다) Zod `safeParse`, 성공하면 Zod 결과(기본값 채움, 정의 밖 칸은 계약대로 거절하거나 버림), 실패하면 Problem 400. `nestjs-zod` 5.5.0은 peer가 NestJS 10·11과 `@nestjs/swagger` 7·8·11까지라(NestJS 12를 쓴다) 같은 일을 하는 파이프를 `packages/platform`에 둔다(guidelines §1의 `nestjs-zod`를 이 파이프로 읽는다).

4. **경로 스키마**: 처리기 장식자 `@ContractRouteSchema({ params, query, headers, body, responses })`(속은 `contractRouteSchema()`)가 계약 Zod를 `z.toJSONSchema()`로 바꿔 `@RouteSchema()`에 넣을 Fastify 스키마를 만든다(요청 `io: "input"`, 응답 `io: "output"`, `target: "draft-07"`). 본문 스키마는 하나다. 형식별(`content`) 스키마는 맞는 형식이 없으면 Fastify가 검사를 건너뛰어 본문 없는 POST가 통과했다(코드 리뷰). 머리 스키마의 칸 이름은 소문자로 바꾼다(Fastify가 사용자 검사기에는 바꾸지 않고 넘긴다). `@ContractRouteSchema`를 단 처리기(그 장식자가 경로 설정에 미루기 표시를 단다)만 검사 결과를 요청에 붙여 두고(`attachValidation`) 인증 가드가 신원을 판정한 뒤 400을 낸다(익명 요청은 401이 먼저). 인증 가드를 지나지 않는 경로는 같은 스키마를 써도 Fastify 기본대로 바로 거절한다(다시 본 리뷰·세 번째 리뷰).
   - 검사기: 플랫폼이 Fastify 검사기 생성기를 바꾼다. Ajv 8(Fastify가 쓰는 판) + `ajv-formats`, `coerceTypes: false`(본문의 `"1"`을 숫자로 바꾸지 않는다. Zod와 같게), `strictNumbers: true`(무한대·NaN 거절. `strict: false`가 끄므로 다시 켠다), `removeAdditional: false`(Fastify 기본 `true`는 `additionalProperties: false`의 정의 밖 칸을 지우고 통과시켜 Zod `.strict()`와 달랐다), `useDefaults: true`(Zod 기본값과 같게), `allErrors: false`. 쿼리·경로·머리는 결정 2를 한 뒤 검사하고 바꾼 값을 넘긴다.
   - 생성 스키마의 검사 규칙(`uniqueItems`·`maxProperties`·`propertyNames.maxLength`, FND-030 결정 10)은 `z.toJSONSchema()`가 빼므로, 생성기가 같은 낱말을 Zod 메타데이터(`.meta()`)로도 단다. Zod는 메타데이터를 JSON Schema에 그대로 싣는다(2026-11-01 확인). 그래서 경로 스키마와 서비스 문서 비교(D-T38) 모두 그 제약을 본다.
   - 응답은 직렬화 스키마에 없는 칸을 내보내지 않는다(fast-json-stringify).
   - 남는 차이: 닫지 않은 객체의 정의 밖 칸을 Zod는 버리고 경로 스키마는 넘긴다. 처리기는 쓸 칸을 골라 쓰고, 핫패스 요청 본문을 계약에서 닫는 일은 BAS-040이다.

5. **Problem 400**: 두 길의 검사 실패, 겹친 쿼리, 깨진 JSON은 모두 `type: about:blank`·`title: Bad Request`·`status: 400`·`instance`·`traceId`만 싣는다(guidelines §2의 '이름이 아직 없는 HTTP 오류'). 검사기마다 문구가 달라 두 길의 본문이 같아지도록 `detail`을 싣지 않고, 값을 되비추지 않는다. 화면은 같은 생성 Zod로 보내기 전에 검사하므로 이 응답은 마지막 방어다. 이름 붙은 400(예: `idempotency-key-invalid`)은 그 모듈이 먼저 낸다(FND-080).

6. **본문 형식과 415**: Fastify 기본 `text/plain` 해석기(문자열을 그대로 넘김)를 지우고 플랫폼 해석기로 바꾼다. 처리기에 `@AcceptTextPlain()`을 단 경로만 `text/plain` 본문을 Fastify 기본 JSON 해석기(원형 오염 키 거부)로 읽고, 그 밖의 경로는 415다. `application/json` 밖의 형식(`application/x-www-form-urlencoded`·`multipart/form-data`·형식 없는 본문 등)은 Fastify 기본대로 415다(2026-11-01 확인). 415는 `about:blank`·`Unsupported Media Type`. multipart 올리기 경로는 그 기능 단계가 해석기를 더한다.

7. **신원과 종료 세션 목록**
   - 게이트웨이 내부 헤더: `x-user-id`(계정)·`x-session-id`(세션)·`x-user-aud`(토큰 대상 `fan`·`partner`·`ops`·`scanner`)·`x-user-scope`(공백으로 이은 스코프)·`x-user-pid`·`x-user-pid-prev`. `X-User-Aud`·`X-User-Scope`의 이름은 이 변경에서 정했다. 정본은 '인가 권한을 내부 헤더로 넘긴다'고만 적었다. 게이트웨이가 이 이름으로 넣는 일과 바깥에서 온 같은 이름을 지우는 일은 HOT-400이다.
   - 종료 세션 목록: 세션 ID → 지울 시각(`terminatedAt` + 15분, 사건에 시각이 없으면 받은 때 + 15분). 주입한 시계로 지난 항목을 지운다. 상한을 두지 않는다(오래된 것부터 밀어내면 끝난 세션이 다시 통한다). 목록에 넣을 때 그 세션의 역할 캐시도 지운다. 사건을 읽어 넣는 소비(방송형, 시작 때 15분 되감기)는 FND-090이 `service.auth.terminateSession()`을 부르는 것으로 잇는다.

8. **역할 가드**
   - 처리기마다 `@Roles([...], { scopes?, fresh? })`를 단다. 값은 authz-matrix §5.5 표의 열두 값이다. 장식자가 없는 처리기나 표에 없는 값이 있으면 시작이 실패한다(AZ-T1).
   - 판정 순서: ① 허용 역할에 `public`이 있고 세션 머리가 없으면 통과(익명) ② 머리(`x-user-id`·`x-session-id`·`x-user-aud`)가 없으면 401 ③ 종료 세션 목록에 있으면 401 ④ 대상이 허용 역할의 무리(팬 `fan`, 파트너 `partner_*`, 관제 다섯 `ops`)와 맞지 않으면 401 ⑤ `scopes`가 있으면 모두 있어야 하고 없으면 403 ⑥ 팬은 여기서 통과 ⑦ 관리 역할은 `GetAdminAuthz`(포트 `ADMIN_AUTHZ`)로 지금 역할·테넌트를 받는다: `valid=false`면 401, 역할이 허용 목록 밖이면 403.
   - 캐시: (계정, 세션)마다 5초 [가정], 주입한 시계로 잰다. `fresh: true`(재인증 토큰을 받는 위험 작업)는 캐시를 쓰지 않고 넣지도 않는다. 조회가 실패(시간 초과·연결 끊김·예외)하고 5초 안의 캐시가 없으면 503 `authz-unavailable`(`Retry-After` 1초 [가정]). 조회 시간 한도는 1초 [가정]와 남은 처리 시간 가운데 짧은 쪽이고, 포트에 `timeoutMs`·`signal`로 넘긴다. 지난 캐시로 통과시키지 않는다. `valid=false`는 캐시하지 않는다.
   - 401은 `about:blank`·`Unauthorized`와 `WWW-Authenticate: Cookie realm="peaket"`(guidelines §12), 403은 `about:blank`·`Forbidden`. 판정한 신원은 요청 맥락(`principal`)과 정규 로그 줄의 가명(`identify`)에 넣는다. 파트너 테넌트는 `principal.tenantId`이고, 경로·쿼리·본문의 `promoterId`는 쓰지 않는다.
   - 현장 스태프(`gate_staff`·`gate_lead`)와 `scanner_device`는 기기 증명(DPoP)과 `CheckScannerSession`이 생기는 GAT-170에서 판정한다. 그 전에는 이 값을 단 처리기가 있으면 시작이 실패한다(조용히 통과시키지 않는다).

9. **Drizzle 설정**
   - 판: `drizzle-orm` 0.45.4, `pg` 8.23.x. `drizzle-kit`(0.31.x)은 마이그레이션 SQL을 만드는 개발 도구라 뼈대의 개발 의존성이다. 실행기는 BAS-060이다.
   - `createDatabase({ url, profile: 'hot'|'general', max, applicationName })`: `pg.Pool`(`connectionTimeoutMillis` 100·1000ms, `idleTimeoutMillis` 10초, `maxLifetimeSeconds` 1800초)과 Drizzle(`node-postgres` 드라이버) 묶음. 연결 시작 매개변수로 `statement_timeout`을 보내지 않는다.
   - 풀 대기 초과(node-postgres의 연결 대기 시간 초과)는 Problem 429 `server-busy`, `Retry-After` 1초 [가정](architecture §5).
   - 트랜잭션 도우미 `transaction(fn, { isolationLevel, accessMode, tenantId, statementTimeoutMs })`: 첫 문장에서 `set_config('app.tenant_id', 값, true)`·`set_config('statement_timeout', 값, true)`(= `SET LOCAL`, 값은 매개변수로 묶는다)를 건다. 끝나면 사라진다.
   - 시험: 실제 PostgreSQL 18 컨테이너(`docker run`, 무작위 포트)로 돈다. 단위 시험과 따로 `test:integration`이고, CI `ci-node`가 함께 돈다. Docker가 없는 곳에서 이 명령은 실패한다(건너뛰지 않는다).

10. **계약 생성물의 실행 빌드**
    - 생성 뒤 처리로 모음 파일(`model/index.ts`)의 상대 다시 내보내기에 `.js`를 붙인다(`export * from './adminAccount.zod.js'`). TypeScript(NodeNext·Bundler)와 Vite는 `.js`를 원본 `.ts`로 찾는다.
    - `@peaket/contracts`에 `build`(`tsc`로 `dist/`)를 두고, 내보내기는 `types`·`development`가 원본 `.ts`, `default`가 `dist/`의 `.js`다. Node(서비스 실행)는 `dist/`를, Vitest와 번들러의 개발 조건은 원본을 읽는다. 서비스는 tsc로만 빌드하므로(묶지 않는다) 데코레이터 메타데이터가 그대로다.

## 남는 것

- V-T41의 처리량·CPU 비교(FND-120). 이 변경은 표본 묶음의 받기·거르기와 Problem 400 본문만 본다.
- `x-peaket-roles`에서 서비스 가드 시험과 게이트웨이 정책을 만드는 생성기(wbs 3.6.1).
- 풀 대기 한도·`SET LOCAL` 왕복 비용 측정(BAS-080).
- 응답 스키마가 없는 처리기를 막는 린트(asvs/delivery.md 15.3.1)는 이 변경에 없다(BAS-010의 정적 검사와 함께).
