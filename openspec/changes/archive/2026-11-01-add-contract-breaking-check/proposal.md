# 제안: 계약 깨짐 검사와 CI 계약 잡(wbs 0.2.1 ②, BUILD_ORDER FND-040)

## Why

계약(openapi·asyncapi)을 고친 PR이 지금 클라이언트를 깨뜨리는지 볼 장치가 없다. 정본은 PR의 계약을 대상 가지의 계약과, 마지막 출시 태그(운영에 나간 판)의 계약과 둘 다 견주라고 한다(docs/api/guidelines.md §1 '차이 검사 도구와 깨짐 기준', ADR-0165, D-T48). 저장소가 하나라 한 PR이 계약과 양쪽 코드를 함께 바꾸면 같은 커밋끼리는 통과하지만, 배포 단위가 따로 나가는 동안 운영의 옛 판과 함께 돌기 때문이다. FND-030이 만든 생성물 차이 검사(`gen:check`)도 CI에서 아직 부르지 않는다.

## What Changes

- **`tools/ci/contract-breaking.mjs`(새 스크립트, 시험 함께)**: 견줄 기준(대상 가지, 마지막 출시 태그)을 고르고, 그 기준의 계약을 꺼내 도구를 부르고, 결과를 모아 판정한다.
  - OpenAPI: `oasdiff breaking --fail-on ERR`(oasdiff 1.34.1). 정본의 '깨짐' 가운데 oasdiff 기본 수준이 낮은 셋(선택 응답 칸 지우기, 응답 열거 값 지우기, 오류 응답 상태 코드 지우기)은 수준 설정 파일로 ERR로 올린다.
  - AsyncAPI: `asyncapi diff -t breaking`(AsyncAPI CLI 6.2.2)이 채널·작업·서버를 본다. 2026-11-01 시험에서 이 도구는 AsyncAPI 3.0 메시지 본문의 필드·열거 기호 지우기를 '분류 안 됨'으로 두어 잡지 못했다. 그래서 메시지 본문은 메시지마다 읽기 작업을 가진 OpenAPI 꼴로 바꿔 같은 oasdiff 규칙으로 견준다.
  - 깨짐 예외 목록: `docs/api/breaking/`의 예외 파일(oasdiff `--err-ignore`, asyncapi `--overrides`). 줄마다 이유가 있어야 하고, 대상 가지보다 예외가 늘었으면 PR에 `breaking-approved` 라벨이 있어야 통과한다.
  - 서비스 OpenAPI 차이(D-T38)의 자리: 서비스가 `openapi:emit`을 갖추면 이 검사가 실패해 비교를 만들게 한다(지금은 서비스가 없어 통과).
- **도구 실행**: 두 도구는 판과 다이제스트를 고정한 공식 컨테이너 이미지로, 네트워크를 끊고 돌린다(설명은 design.md 결정 1).
- **`.github/workflows/contract-check.yml`(새, 재사용 워크플로)와 `ci.yml`**: 계약 범위(`contracts`)가 바뀐 PR·푸시에서 생성물 차이 검사·계약 패키지 시험·깨짐 검사를 돌리고, `ci-summary`의 필수 검사에 넣는다.
- **`tools/ci/release-tags.mjs`(새 공용 모듈)**: 출시 태그 규칙(`vX.Y.Z`)과 정렬을 `release-plan.mjs`와 함께 쓴다.
- 시스템 바깥 행동은 바뀌지 않는다(CI 도구). 명세는 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. CI 도구 작업이다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/api/guidelines.md §1(깨짐 기준·도구·예외), docs/devops.md §3.1(`contract-check.yml` 행, '지금 있는 것')·§3.3·§4.4, 시험 D-T48·D-T38, ADR-0165 결정 4, 기술 검토 낮음-019·중간-085, wbs 0.2.1(②).
- **ASVS**: 새 기능이 아니라 추적 표를 새로 쓰지 않는다. docs/security/asvs/delivery.md(빌드 절차·공급망)의 범위다. 운영 확인 표(§8.4)는 해당 없음이다.
- **코드**: `tools/ci/`(스크립트 둘·시험), `docs/api/breaking/`(수준·예외 파일), `.github/workflows/contract-check.yml`·`ci.yml`, `tools/ci/README.md`.
- **외부**: 컨테이너 이미지 둘(`tufin/oasdiff` v1.34.1 2026-10-21 게시, `asyncapi/cli` 6.2.2 2026-10-26 게시, 다이제스트 고정). npm 의존성은 늘지 않는다. 원격이 없어 GitHub에서는 돌리지 못하고, 로컬에서 같은 명령(Docker)과 워크플로 규칙 검사까지 확인한다. 화면이 없어 브라우저 확인은 '해당 없음'이다.
