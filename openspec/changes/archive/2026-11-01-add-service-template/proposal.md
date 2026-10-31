# 제안: 서비스 템플릿 뼈대(wbs 0.3.1 ①, BUILD_ORDER FND-050)

## Why

서비스 10개가 함께 쓸 서버 공용 패키지 `packages/platform`이 아직 없다. 정본은 이 패키지가 모든 서비스에 같은 모양의 계측(네 신호), 오류 응답(RFC 9457 Problem), 남은 시간(deadline) 전파를 기본으로 넣으라고 한다(NFR-011, ADR-0077, docs/api/guidelines.md §2·§5, docs/observability.md §2·§3·§8). 서비스가 생기기 전에 템플릿이 있어야 첫 서비스(Phase 1 v0)가 그 위에서 시작한다.

FND-040은 서비스 OpenAPI 차이 검사(D-T38)의 자리만 두었다. 서비스가 `@nestjs/swagger`로 만든 문서를 계약과 견주는 본체가 없어, `openapi:emit`을 가진 서비스가 생기면 CI가 실패한다. 자바스크립트 작업 공간의 타입 검사·시험·빌드를 돌리는 CI 잡(`ci-node.yml`, wbs 0.1.2의 남은 것)도 없다.

## What Changes

- **`packages/platform`(새, `@peaket/platform`)**: NestJS 12 + Fastify 5 위의 서비스 시작 코드.
  - 네 신호 계측: 지연 히스토그램(표준 칸 20개, ADR-0077 결정 1·observability §8), 처리 중 요청 게이지 `http_server_active_requests`(ADR-0077 결정 5), 5xx 오류 카운터와 정상 분기 거절 카운터(ADR-0069 결정 5, guidelines §2), Node 기본 지표(이벤트 루프 지연). 지표는 앱 포트가 아닌 관리 포트의 `/metrics`로만 낸다(ASVS 13.4.5).
  - RFC 9457 Problem: 전역 예외 필터가 모든 오류를 `application/problem+json`으로 바꾼다. 예상하지 못한 오류는 500과 일반 문구, `traceId`만 내고 원본은 서버 기록으로만 남긴다(ASVS 16.5.1). `debug` 확장은 로컬·CI에서만 켜고, 다른 환경에서 켜면 시작하지 않는다(ADR-0081, ASVS 13.4.2).
  - deadline 전파: 게이트웨이가 넣은 남은 시간을 받아 요청 맥락에 두고, 다음 호출에 줄 시간을 계산하며, 모자라면 시작하지 않고 바로 실패한다(guidelines §5, ADR-0009 결정 4). 시간은 주입한 시계(Clock)로 잰다.
  - 서비스 OpenAPI 문서 뽑기(`emitOpenApi`)와 계약 Zod를 OpenAPI 스키마로 바꾸는 도우미. 실행 중인 서비스는 문서 경로를 내지 않는다(D-T38).
- **`tools/ci/service-openapi.mjs`(새, 시험 함께)**: D-T38 비교 본체. 서비스가 맡는다고 적은 계약 작업만 경로·메서드·매개변수·요청과 응답 본문의 모양으로 견준다. `node tools/ci/contract-breaking.mjs services`가 이것을 부른다.
- **`.github/workflows/ci-node.yml`(새)와 `ci.yml`**: 자바스크립트 범위가 바뀌면 Turborepo로 타입 검사·시험·빌드를 돌리고(`--affected`, 넓게 쓰이는 것이 바뀌면 전체) `ci-summary`에 넣는다.
- **설치 규칙**: `@nestjs/swagger` → `swagger-ui-dist`가 끌고 오는 `@scarf/scarf`의 설치 스크립트(설치 때 사용 통계 전송)는 거부로 적는다(`allowBuilds: false`).
- 정본: 지표 이름·라벨, deadline 헤더 이름과 기본값, 504 `deadline-exceeded`, 이름 없는 오류의 `about:blank`, 환경 이름 `PEAKET_ENV`, 서비스가 맡는 계약 작업 목록을 정본(observability §3, guidelines §2·§5, devops §3.1)에 '추천 적용 2026-11-01'로 적는다.

## Capabilities

### New Capabilities

- `service-template`: 서비스 공용 시작 코드가 밖으로 보이는 행동(지표, 오류 응답, deadline, 문서 경로 없음)과 서비스 OpenAPI 차이 검사.

### Modified Capabilities

- 없음.

## Impact

- 정본과 ID: NFR-011·NFR-003, ADR-0009 결정 4, ADR-0069 결정 5, ADR-0077 결정 1·5, ADR-0081, ADR-0131(D-T38), ADR-0165, docs/api/guidelines.md §2·§5, docs/observability.md §2·§3·§8, docs/devops.md §3.1·§4.4·D-T38·D-T47, docs/verification.md §2.7(지표 내보내기 층), ASVS v5.0.0-13.4.2·13.4.5·16.5.1·16.3.4(docs/security/asvs/delivery.md), wbs 0.3.1 ①·0.2.1·0.1.2.
- 코드: `packages/platform/`(새), `tools/ci/service-openapi.mjs`·`contract-breaking.mjs`, `.github/workflows/ci-node.yml`(새)·`ci.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`.
- 문서: docs/observability.md §3(지표 이름·운영 확인 표), docs/api/guidelines.md §2·§5, docs/devops.md §3.1, docs/security/asvs/delivery.md, packages/README.md, tools/ci/README.md, wbs 0.3.1·0.2.1·0.1.2(md·csv), BUILD_ORDER, 00-summary §4, consistency-review(R 번호).
- 하지 않는 것(정본이 다른 단계에 둔 것): 로그 가명·정규 로그 줄·추적 문맥 규칙(FND-060), 인증 가드·층 의존 린트·`text/plain` 해석기·경로 스키마 변환(FND-070), 프로브·시간 초과 기본값(wbs 0.3.6), gRPC 채널 생성 함수(FND-100), ASVS 태그 보고와 컨테이너 통합 시험(그 시험이 생기는 단계).
