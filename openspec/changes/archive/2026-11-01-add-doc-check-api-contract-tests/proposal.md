# 제안: 문서 점검 도구 openapi 계약 검사의 시험(wbs 0.1.3의 남은 것, BUILD_ORDER FND-020)

## Why

wbs 0.1.3은 "doc-check `api`의 호스트·security 검사와 명세 숫자 보고는 남았다"고 적혀 있다. 그런데 `tools/doc-check/check_all.py`를 정본과 대조해 보니, 기술 검토 낮음-031·032가 정한 것은 2026-10-28 커밋 `ae46d5c`에서 이미 들어갔다(아래 대조표). 남은 빈틈은 이 검사가 제대로 잡는지 지켜 주는 시험이 하나도 없다는 것이다. CI는 실제 openapi 한 벌로만 도구를 돌린다. 그래서 누가 검사를 고치다 망가뜨려도 실제 명세에 오류가 없으면 아무도 모른다. `tools/ci/`의 도구는 모두 시험이 있는데 문서 점검 도구만 없다.

대조표(정본 → 지금 코드):

| 정본이 정한 것 | 근거 | 지금 코드 |
| --- | --- | --- |
| 접두사 규칙(`x-peaket-gateways`, 위에서 처음 맞는 것)이나 경로 `servers`로 호스트 하나에 정해지지 않는 작업은 오류 | guidelines §10, 낮음-031 | 있음(`missing_host` 오류) |
| `security`가 가리키는 이름이 `securitySchemes`에 없는 작업은 오류(전역 `security` 포함) | guidelines §10, 낮음-031 | 있음 |
| `security`를 적지 않았는데 전역 `security`도 없는 작업은 오류. 공개 작업은 `security: []` | guidelines §10·§12, 낮음-031 | 있음(`public` 수 보고) |
| 작업 수, Problem을 선언한 4xx·5xx 수와 예외 목록, `operationId`·`servers`·`security`가 빠진 작업 수를 돌 때마다 보고 | guidelines §12 '자기 서술성 점검', 낮음-032 | 있음(`api`·`api_hosts`·`api_problem_exempt` 정보 줄). `servers`가 빠진 작업은 호스트가 정해지지 않은 작업(`missing_host`)으로 센다. 경로마다 `servers`를 베끼지 않고 접두사 규칙 한 표로 두기 때문이다(guidelines §10) |

## What Changes

- **`tools/doc-check/test_api_contract.py`**(새 시험, 표준 라이브러리 `unittest`): openapi 글을 넣어 `api` 검사가 내는 오류와 보고를 확인한다. 위 대조표의 행마다 잡아야 할 경우와 잡지 말아야 할 경우를 둔다.
- **`.github/workflows/docs-check.yml`**: 문서 점검을 돌리기 전에 이 시험을 돌린다. `tools/doc-check/`가 바뀌면 이미 `docs` 범위로 잡혀 이 워크플로가 돈다(`tools/ci/changes.mjs`).
- **`tools/doc-check/README.md`**: 시험 실행법을 적고, 'CI 연결은 wbs 0.1.3 작업이다'라는 옛 문장을 고친다.
- 검사의 동작은 바꾸지 않는다. 명세는 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. 문서 점검 도구의 시험이다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/api/guidelines.md §10('경로의 호스트와 인증을 명세에 적는다')·§12('자기 서술성 점검'), docs/devops.md §3.1(`docs-check.yml` 행), tools/doc-check/README.md, 기술 검토 낮음-031·032(ADR-0133), wbs 0.1.3(md·csv 상태 칸).
- **ASVS**: 새 기능이 아니라 추적 표를 새로 쓰지 않는다. 운영 확인 표(§8.4)도 돌아가는 서비스가 없어 해당 없음이다.
- **코드**: `tools/doc-check/`의 시험 하나와 README, `.github/workflows/docs-check.yml`의 단계 하나. 원격이 없어 GitHub에서 돌리지는 못하고, 로컬에서 같은 명령과 워크플로 규칙 검사(`node tools/ci/check-workflows.mjs`)까지 확인한다.
- **외부**: 없음(표준 라이브러리만). 화면이 없어 브라우저 확인은 '해당 없음'이다.
