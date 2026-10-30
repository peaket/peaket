# 제안: 공용 CI 뼈대(wbs 0.1.2의 첫 묶음과 0.1.3)

## Why

규칙 세트가 기다리는 필수 검사 셋(`ci-summary`, `branch-policy`, `merge-tree`, devops §2.2.6)을 내는 워크플로가 아직 없다. 이것이 없으면 GitHub 설정을 적용할 수 없다(스택 안내서 5단계). 빌드할 코드(서비스, 화면 앱)는 아직 없으므로, 지금은 모든 PR에서 도는 뼈대와 지금 있는 것(문서, 점검 스크립트, Terraform)을 검사하는 잡까지 만든다.

## What Changes

- **`ci.yml`**: 모든 PR과 `develop`·`main`·`release/*`·`hotfix/*` 푸시에서 돈다. 첫 잡 `changes`가 바뀐 범위를 고르고, 범위에 맞는 잡(`docs-check`, `tools-check`, `iac-check`. 각각 같은 이름의 재사용 워크플로를 부른다)만 돈다. 마지막 잡 `ci-summary`가 앞 잡의 결과를 모아 필수 검사 하나로 낸다(devops §3.1, D-T47).
- **`tools/ci/changes.mjs`**: `git diff --name-only`로 바뀐 범위를 고르는 저장소 안 스크립트. 범위를 고르지 못하면 전체를 고른다.
- **`branch-policy.yml`과 `tools/ci/branch-policy.mjs`**: 가지 쌍, PR 제목 형식(Conventional Commits, 허용 종류, `BREAKING CHANGE`와 `!`), 빌드 절차 변경 PR에 다른 경로가 섞였는지, 작업 가지 나이 경고(devops §2.2.6, D-T41, ADR-0169).
- **`merge-tree.yml`과 `tools/ci/check-merge-tree.mjs`**: `main`으로 가는 PR의 병합 결과 트리가 후보 커밋의 트리와 같은지(devops §2.2.4).
- **`tools/ci/check-workflows.mjs`**: 워크플로 규칙 검사. 액션을 커밋 SHA로 고정했는지, `pull_request_target`을 쓰지 않는지, 맨 위 `permissions`가 있는지, PR 제목·본문·가지 이름을 셸에 바로 끼워 넣지 않는지(devops §4.5).
- **Renovate 설정**(`renovate.json`): 새 판 3일 대기, 액션 SHA 고정, Conventional Commits 제목(devops §4.4·§4.5, D-T41).
- **Actions 허용 목록**: Terraform 변수 기본값에 `hashicorp/setup-terraform@*`를 더한다(devops §4.5, 이 변경에서 처음 쓰는 제3자 액션).
- 바뀌는 동작(사용자·시스템이 보는 행동)은 없다. 도구 작업이라 명세를 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. CI 도구 작업이라 시스템 행동 명세가 생기지 않는다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/devops.md §2.2.4(병합 결과 트리 검사), §2.2.6(가지 규칙 검사·PR 제목·필수 검사 이름), §3.1(공용 워크플로, 바뀐 범위), §3.4(CI 속도, concurrency), §4.4·§4.5(Renovate, SHA 고정, 토큰 권한, `pull_request_target` 금지), 시험 D-T41·D-T47
- **결정**: ADR-0054, ADR-0074, ADR-0165, ADR-0167, ADR-0169
- **ASVS**: docs/security/asvs/delivery.md(공급망과 CI 행). 새 기능이 아니라 추적 표를 새로 쓰지 않는다.
- **WBS**: 0.1.2의 첫 묶음과 0.1.3(문서 점검 CI 연결). 0.1.2의 나머지(릴리스·핫픽스 워크플로, 야간 성능 잡, 다중 아키텍처 이미지 빌드, 화면·서비스·계약 잡)는 그 대상이 생기는 변경에서 한다.
- **코드**: `.github/workflows/` 셋, `tools/ci/` 스크립트 넷과 시험, `renovate.json`, Terraform 변수 기본값 하나. 원격 저장소가 없어 GitHub에서 실제로 돌리지는 못한다. 스크립트 시험과 워크플로 검사, YAML 읽기까지 로컬에서 확인한다.
- **외부**: GitHub 소유 액션 둘(`actions/checkout`, `actions/setup-node`)과 HashiCorp `setup-terraform`을 커밋 SHA로 고정해 쓴다. 화면이 없어 브라우저 확인은 '해당 없음'이다.
