# 제안: 계약에서 만든 코드 패키지와 작업 공간 시험 도구(wbs 0.2.1 ①, BUILD_ORDER FND-030)

## Why

계약 원본(`docs/api/openapi.yaml`·`asyncapi.yaml`)은 있지만, 그 계약에서 만든 코드를 둘 `packages/contracts`가 없다. 화면과 서버가 함께 쓰는 요청·응답 Zod 스키마는 계약에서 만들어야 한다(docs/api/guidelines.md §1, architecture §10 '계약 우선'). 그런데 지금은 그 스키마를 만들 곳도, 계약이 바뀌었는데 다시 만들지 않은 것을 잡을 장치도 없다. 또 작업 공간에는 정본의 시험 도구(Vitest, docs/frontend.md §5.17)와 모든 패키지의 시험을 한 번에 돌리는 작업(Turborepo `test`)이 없다. 퍼블리싱 화면의 시험은 패키지마다 `node --test`로 따로 돈다.

## What Changes

- **`packages/contracts`(새 패키지, `@peaket/contracts`, 게시하지 않음)**
  - orval 8로 `docs/api/openapi.yaml`에서 작업별 요청·응답 Zod 스키마와 구성 요소 스키마(`components.schemas`)의 Zod 스키마·TypeScript 타입을 만든다(`src/gen/openapi/`).
  - `docs/api/asyncapi.yaml`의 메시지 본문(바이너리 메시지는 빼고)을 OpenAPI 구성 요소 꼴로 옮기는 작은 변환기를 거쳐 같은 orval로 Zod 스키마·타입을 만든다(`src/gen/asyncapi/`).
  - 생성물은 손으로 고치지 않고 커밋한다. 생성물 차이 검사(`gen:check`)는 저장소 밖 임시 폴더에 다시 만들어 커밋된 것과 견주고, 다르면 바뀐 파일 목록과 함께 실패한다. 같은 검사를 시험으로도 둬서 `pnpm test`가 잡는다.
  - 변환기·차이 검사·생성 스키마의 행동은 Vitest 시험으로 확인한다.
- **작업 공간 시험 도구**: Turborepo `test` 작업과 뿌리 `pnpm test`. Vitest는 정본의 단위 시험 도구이고 `packages/contracts`가 처음 쓴다. 지금 있는 패키지의 `node --test` 시험도 같은 `pnpm test`로 돈다.
- **계약 고침(구현 중 찾음)**: orval의 OpenAPI 검증이 계약 원본의 규격 위반 셋을 막았다. ① `GET /v1/ops/compliance/documents/{documentId}`의 200 응답에서 응답 형식(Media Type) 둘에 둔 `description`(OpenAPI 3.1에서 응답 형식에는 이 칸이 없다) ② `staffToken`(`type: http`, `scheme: DPoP`)의 `bearerFormat`(OpenAPI 3.1 스키마는 `scheme`이 bearer일 때만 받는다). 뜻은 응답 설명과 인증 방식 설명으로 옮긴다. 계약의 행동은 바뀌지 않는다.
- **정본 맞춤**: docs/frontend.md §2.2는 orval Zod 생성물을 `packages/validation/src/gen/`·`packages/api-client/src/gen/`에 둔다고 적었다(2026-10-28). 그 뒤 ADR-0165(2026-10-30)와 devops §2.1·architecture §10은 '계약에서 만든 코드(Zod 스키마, TypeScript 타입, gRPC 스텁)'를 `packages/contracts`에 둔다. 더 새로운 결정을 따라, 요청·응답 Zod와 타입은 `packages/contracts` 한 곳에 만들고 `validation`은 그것을 다시 내보내며 손 규칙만 더한다고 frontend §2.2를 고친다. 호출 클라이언트·MSW 핸들러(화면 전용 생성물)는 `api-client`를 만드는 단계(wbs 0.6.4)의 몫으로 남긴다(추천 적용 2026-11-01).
- 시스템 바깥 행동은 바뀌지 않는다(계약에서 만든 코드와 시험 도구). 명세는 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. 도구·생성 코드 작업이다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/api/guidelines.md §1('계약 파일이 원본이다'), docs/architecture.md §10(`packages/contracts` 행, '계약 우선'), docs/devops.md §2.1·§3.1(`contract-check.yml`)·§4.4(공급망 설정), docs/frontend.md §2.2(패키지 구조, '생성물' 행, '지금 있는 것')·§5.17(Vitest), ADR-0165, 기술 검토 중간-085, wbs 0.2.1(①만. ②의 깨짐 검사·서비스 OpenAPI 차이·CI 계약 잡은 FND-040), wbs 0.6.4(시험 도구를 앞당긴 부분).
- **계약**: docs/api/openapi.yaml(위 규격 위반 셋. 경로·작업·본문 모양은 그대로).
- **ASVS**: 새 기능이 아니라 추적 표를 새로 쓰지 않는다. docs/security/asvs/delivery.md의 v5.0.0-15.2.4(내부 패키지는 게시하지 않고 `workspace:`로만 잇는다)를 따른다. 생성 Zod를 입력 검사에 쓰는 것은 그 검사를 쓰는 서비스·화면 단계의 추적 표에서 본다. 운영 확인 표(§8.4)는 돌아가는 서비스가 없어 해당 없음이다.
- **코드**: `packages/contracts`(설정, 생성 스크립트, 변환기, 차이 검사, 시험, 생성물), 뿌리 `package.json`·`turbo.json`, `pnpm-lock.yaml`.
- **외부 의존성**(모두 게시 뒤 3일이 지난 판, devops §4.4): `orval` 8.45.0(개발), `zod` 4.6.7(실행), `vitest` 5.0.5(개발), `yaml` 2.9.1(개발, asyncapi 읽기), `@types/node`(개발). 설치 스크립트 허용 목록은 늘리지 않는다. 화면이 없어 브라우저 확인은 '해당 없음'이다.
