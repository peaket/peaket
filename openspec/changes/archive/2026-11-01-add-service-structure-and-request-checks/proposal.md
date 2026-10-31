# 제안: 서비스 안 구조·요청 검사·인증 가드·Drizzle 설정(wbs 0.3.2 ①, BUILD_ORDER FND-070)

## Why

FND-050·060이 만든 서비스 템플릿(`packages/platform`)에는 지표·Problem·남은 시간·정규 로그 줄은 있지만, 서비스가 요청을 받아 업무를 처리하는 데 필요한 공용 부품이 아직 없다. 첫 서비스가 생기기 전에 다음이 있어야 서비스 열 개가 같은 모양으로 시작한다.

- 서비스 안 구조의 기본값(받는 층 → 유스케이스 층 → 도메인 층, 바깥 의존은 포트 뒤 어댑터)과 층을 거꾸로 부르는 import를 막는 공용 린트(docs/architecture.md §3.1, 기술 검토 낮음-008).
- 계약에서 만든 Zod로 요청을 검사하는 길 둘: 일반 경로의 Zod 파이프와 핫패스의 Fastify 경로 스키마(`z.toJSONSchema()`), `text/plain` 해석기, 검사 실패의 Problem 400, 두 길이 같은 표본을 같게 거르는지 보는 시험(docs/api/guidelines.md §1, ADR-0023, 기술 검토 낮음-001, V-T41의 표본 묶음).
- 본문이 있는 쓰기 요청은 `application/json`만 받고(대기열 두 경로만 `text/plain`도) 그 밖은 415(asvs/delivery.md 3.5.2, ADR-0065 결정 6).
- 공통 인증 가드와 종료 세션 목록(identity §3 '세션 즉시 무효화 전파', ASVS 7.4.1), 처리기마다 허용 역할을 적고 역할을 요청마다 identity에서 받는 `RolesGuard`(소유자 결정 2026-10-31, ADR-0172, authz-matrix §5.2, ASVS 8.2.1).
- Drizzle 설정: 연결 풀 기본값, 트랜잭션 범위 설정(`SET LOCAL`), 풀 대기 초과의 429(ADR-0037, ADR-0070, ADR-0083, authz-matrix §5.3).
- 서버가 `@peaket/contracts`를 실행 중에 읽는 빌드 방식(FND-050에서 넘김, R-221).

## What Changes

- **서비스 안 구조 뼈대**: `packages/platform/template/`에 서비스 하나의 최소 모양(뿌리 모듈, 바운디드 컨텍스트 모듈 하나의 `inbound`·`application`·`domain`·`adapters`, Drizzle 스키마·설정)을 두고, 그것이 실제로 뜨는지 시험한다. 층 규칙은 `packages/config`의 공용 ESLint 설정(`no-restricted-imports`)이고 뿌리 `pnpm lint`와 CI가 돈다.
- **요청 검사**: 계약 Zod를 받는 매개변수 장식자(본문·쿼리·경로·머리). 검사 전에 쿼리·경로·머리의 문자열을 계약의 형식대로 바꾸고(숫자·불리언, 머리 이름 대소문자, 쉼표로 이은 배열), 같은 이름이 겹쳐 온 쿼리는 거절한다(ASVS 15.3.7).
- **경로 스키마**: 계약 Zod를 Fastify 경로 스키마로 바꾸는 함수와 플랫폼 검사기(같은 문자열 바꾸기, 형 바꾸기·칸 지우기 없음). 생성 스키마의 검사 규칙(중복 금지·칸 수·칸 이름 길이)은 생성기가 같은 JSON Schema 낱말을 메타데이터로 달아 경로 스키마에도 남는다.
- **본문 형식**: Fastify 기본 `text/plain` 해석기를 바꿔, `text/plain`을 받도록 표시한 경로에서만 JSON으로 읽고 그 밖은 415.
- **인증 가드·종료 세션 목록·역할 가드**: 게이트웨이 내부 헤더로 신원을 받고, 끝난 세션은 401, 허용 역할이 없는 처리기는 시작 실패, 관리 역할은 identity 조회(5초 캐시, 위험 작업은 캐시 없음, 답이 없으면 503 `authz-unavailable`).
- **Drizzle 설정**: 연결 풀·Drizzle 묶음, 트랜잭션 도우미(격리 수준, `SET LOCAL app.tenant_id`·`statement_timeout`), 풀 대기 초과 → 429 `server-busy`. 실제 PostgreSQL 컨테이너 시험(`test:integration`)과 CI 단계.
- **계약 생성물 빌드**: 생성된 모음 파일의 다시 내보내기에 `.js` 확장자를 붙이고, `tsc`로 `dist/`를 만든다. Node는 `dist/`를, 번들러·Vitest의 개발 조건은 원본을 읽는다.

## Impact

- 정본: docs/architecture.md §3.1·§5·§10, docs/api/guidelines.md §1·§2·§7·§12, docs/security/authz-matrix.md §5.2·§5.3·§5.5, docs/features/identity.md §3, docs/security/asvs/delivery.md(3.5.2·13.1.2·15.3.3·15.3.7)·auth.md(7.4.1·8.2.1·8.3.1), docs/observability.md §3(서비스 템플릿 운영 확인 표), docs/devops.md §3.1(ci-node), docs/data.md(Drizzle), packages/contracts/README.md.
- ID: NFR-016, ADR-0008·0011·0023·0037·0050·0065·0070·0083·0172, 기술 검토 낮음-001·낮음-008·낮음-140, 시험 AZ-T1·AZ-T16(일부)·I-T48(일부)·V-T41(표본 묶음), WBS 0.3.2.
- 코드: packages/platform(새 모듈과 template/), packages/contracts(생성 뒤 처리·빌드·내보내기), packages/config(ESLint 설정), 뿌리 package.json·eslint.config.mjs, .github/workflows/ci-node.yml, pnpm-lock.yaml.
- 넘김: Idempotency-Key 검사 실패의 400 `idempotency-key-invalid`는 FND-080, 종료 세션 사건 소비(방송형)는 FND-090, 게이트웨이의 새 내부 헤더(`X-User-Aud`·`X-User-Scope`)는 HOT-400, 현장 스태프 역할 판정은 GAT-170, V-T41 측정은 FND-120, 풀 대기 한도 측정은 BAS-080.
