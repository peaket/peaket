# Tasks

## 1. 바뀐 범위 고르기

- [x] 1.1 `tools/ci/changes.mjs`와 시험을 만든다(design.md 결정 2). 시험은 임시 git 저장소에서 D-T47의 네 경우를 본다: 문서만 → `docs`만, `packages/platform` → `js`와 `js_all`, `infra/`만 → `infra`만, 비교 기준이 없거나 git이 실패 → 전체. 확인: `node --test "tools/ci/*.test.mjs"`가 통과한다.

## 2. 가지 규칙과 병합 결과 트리

- [x] 2.1 `tools/ci/branch-policy.mjs`와 시험을 만든다(결정 3). 시험: 허용·거부 가지 쌍, D-T41의 다섯 경우, 빌드 절차 변경 PR에 다른 경로가 섞인 경우, 사건 파일에서 PR 정보를 읽는 것. 확인: 같은 시험이 통과한다.
- [x] 2.2 `tools/ci/check-merge-tree.mjs`와 시험을 만든다(결정 4). 시험: 후보가 대상을 모두 담은 경우는 통과, 대상에만 있는 변경이 있으면 실패, 충돌이면 실패. 확인: 같은 시험이 통과한다.

## 3. 워크플로와 그 규칙

- [x] 3.1 `tools/ci/check-workflows.mjs`와 시험을 만든다(결정 5). 확인: 같은 시험이 통과한다.
- [x] 3.2 `.github/workflows/ci.yml`(잡 `changes`, `docs-check`, `tools-check`, `iac-check`, `ci-summary`)과 그것이 부르는 재사용 워크플로 `docs-check.yml`·`tools-check.yml`·`iac-check.yml`, `branch-policy.yml`(잡 `branch-policy`), `merge-tree.yml`(잡 `merge-tree`)을 만든다(결정 6~10). `ci-summary`의 판정은 `tools/ci/ci-summary.mjs`와 그 시험으로 둔다. 액션은 design.md의 커밋 SHA로 고정한다. 확인: `node tools/ci/check-workflows.mjs`가 통과하고 세 파일이 YAML로 읽히며, 필수 검사 이름 셋이 잡 이름에 있다.
- [x] 3.3 `renovate.json`을 두고, Terraform 변수 `actions_patterns_allowed`의 기본값에 `hashicorp/setup-terraform@*`를 더한다. 확인: `renovate.json`이 JSON으로 읽히고 `terraform validate`가 통과한다.
- [x] 3.4 `tools/ci/README.md`에 스크립트마다 하는 일과 실행법을 적는다. 확인: 적은 명령이 그대로 돈다.

## 4. 정본 반영과 통합 확인

- [x] 4.1 정본에 반영한다: devops §3.1(지금 있는 워크플로·스크립트, D-T32의 옛 `.github` 저장소 표현), wbs 0.1.2·0.1.3(CSV 포함). 확인: 문서 점검 오류 0이다.
- [x] 4.2 전체를 한 번에 확인한다: `node --test "tools/ci/*.test.mjs"`, 저장소에서 `changes`·`check-workflows`·CODEOWNERS·`workspace:` 검사, `terraform fmt`·`validate`, 문서 점검, 새 파일의 줄바꿈 LF. 확인: 모두 통과한다.

## Workflow follow-up

- 대조: `pnpm exec openspec` 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: `/code-review`, 나온 것은 이 사이클에서 고친다(사이클 단위로 맡기기, architecture §8.6). 2026-10-31에 10건이 나왔고 모두 고쳤다. 버그 4건은 재현 시험을 먼저 만들어 실패를 본 뒤 고쳤다(R-202).
- 보관: `pnpm exec openspec archive add-ci-foundation --yes`, 그리고 `develop`에 커밋.
- 원격을 만든 뒤: 첫 PR에서 D-T47·D-T41을 실제로 돌려 본다.
