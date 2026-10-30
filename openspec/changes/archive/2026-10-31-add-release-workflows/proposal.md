# 제안: 릴리스·핫픽스 워크플로(wbs 0.1.2의 남은 것, BUILD_ORDER FND-010)

## Why

git flow의 출시 경로(devops §2.2.2 릴리스, §2.2.3 핫픽스, §2.2.4 병합 결과 트리)를 실제로 움직이는 `release.yml`이 아직 없다. 지금은 가지 규칙 검사와 병합 결과 트리 검사(필수 검사)만 있고, 릴리스 가지를 자르고, 버전을 정하고, `main`에 넣고, 태그를 다는 일을 할 곳이 없다. 원격 저장소와 릴리스 봇 앱은 아직 없으므로(PROGRESS OPEN[01]), 판단은 모두 시험할 수 있는 스크립트로 만들고 워크플로는 그것을 부르기만 한다.

## What Changes

- **`tools/ci/release-plan.mjs`**(새 스크립트): 세 하위 명령.
  - `start`: 릴리스(`develop`에서)나 핫픽스(마지막 출시 태그에서)를 열 계획을 낸다. 마지막 출시 태그 뒤 커밋의 Conventional Commits 제목으로 다음 버전을 정하고(SemVer, 운영 출시 전 0.y.z 규칙, D-T41 ④), 변경 기록과 바뀐 배포 단위 목록을 만들고, 버전을 올린 `package.json`을 만든다. 출시할 변경이 없거나 이미 열린 릴리스 가지가 있으면 아무것도 열지 않는다.
  - `finish`: 마무리할 가지 이름을 검사하고, 태그 이름·후보 커밋·역병합 대상(열린 릴리스 가지가 있는 핫픽스는 그 가지, D-T25)·역병합 가지 이름·변경 기록을 낸다.
  - `verify`: `main` 병합 커밋의 두 번째 부모가 후보 커밋이고 트리가 같은지 확인하고(§2.2.4 병합 뒤), 출시 기록(태그 커밋·후보 커밋·트리 해시)을 변경 기록에 붙인다.
- **`tools/ci/conventional.mjs`**(새 공용 모듈): Conventional Commits 제목 해석. `branch-policy.mjs`의 제목 검사와 `release-plan.mjs`의 버전 계산이 같은 규칙을 쓰게 한다.
- **`.github/workflows/release.yml`**: 주 1회 예약과 수동 실행(`start-release`, `start-hotfix`, `finish`). 가지·태그·PR 작업은 릴리스 봇 앱의 설치 토큰으로 GitHub API를 부른다(`release` 환경).
- **`branch-policy.mjs` 고침**: 같은 저장소의 릴리스·핫픽스·역병합 PR은 빌드 절차 변경 분리 검사를 보호 가지에 아직 없는 새 커밋에만 건다. 이 PR들은 이미 검토를 거친 변경을 옮길 뿐이라, 지금대로면 지난 출시 뒤 워크플로가 한 번이라도 바뀐 릴리스 PR이 늘 실패한다. 포크 PR은 지금처럼 바뀐 파일 전부를 본다.
- **`check-workflows.mjs` 고침**(구현 중 찾음): 사건 종류 `github.event_name`을 사용자 입력으로 잘못 막던 것을 고친다. `release.yml`의 잡 조건에서 드러났다.
- 시스템 바깥 행동은 바뀌지 않는다(CI 도구). 명세는 쓰지 않는다(`skip_specs: true`).

## Capabilities

### New Capabilities

- 없음. CI 도구 작업이다.

### Modified Capabilities

- 없음.

## Impact

- **정본**: docs/devops.md §2.2.1(역병합 가지), §2.2.2(릴리스, 첫 커밋), §2.2.3(핫픽스), §2.2.4(병합 결과 트리), §2.2.5(버전·변경 기록·서비스 식별), §2.2.6(가지 규칙 검사, 릴리스 봇), §3.1(`release.yml` 행과 '지금 있는 것'), 시험 D-T22·D-T23·D-T25·D-T41 ④. 원격이 있어야 하는 D-T24·D-T26은 이 변경에서 확인하지 못한다.
- **결정**: ADR-0074(git flow), ADR-0165(시스템 판 하나, 바뀐 배포 단위만 새 이미지), ADR-0169(빌드 절차 같은 저장소)
- **ASVS**: docs/security/asvs/delivery.md(릴리스 봇 키, 가지·태그 규칙 세트 행). 새 기능이 아니라 추적 표를 새로 쓰지 않는다. 비밀 목록은 docs/security/secrets-and-keys.md의 '릴리스 봇' 행 그대로다.
- **WBS**: 0.1.2의 릴리스·핫픽스 워크플로. 작업 가지 수 경고와 병합 방식 주간 점검은 정본대로 원격을 만든 뒤 한다(devops §3.1 `branch-policy.yml` 행, R-202, BUILD_ORDER FND-160).
- **코드**: `tools/ci/` 스크립트 둘과 시험, `branch-policy.mjs`, `.github/workflows/release.yml`. GitHub에서 실제로 돌리지는 못한다. 스크립트 시험과 워크플로 규칙 검사까지 로컬에서 확인한다.
- **외부**: GitHub 소유 액션 `actions/create-github-app-token`을 커밋 SHA로 고정해 새로 쓴다(조직 허용 목록의 GitHub 소유 허용으로 들어온다, Terraform 변경 없음). 화면이 없어 브라우저 확인은 '해당 없음'이다.
