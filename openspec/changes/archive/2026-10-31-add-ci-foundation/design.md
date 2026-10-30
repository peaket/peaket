# 설계: 공용 CI 뼈대

## Context

- 저장소는 공개 모노레포 `peaket` 하나다(ADR-0169). 빌드 절차는 `peaket`의 `.github/workflows/`에 둔다.
- 규칙 세트(`infra/modules/github`)는 필수 검사 `ci-summary`·`branch-policy`(`develop`), 여기에 `merge-tree`(`main`)를 GitHub Actions 앱에서 온 것만 받는다. 워크플로의 잡 이름이 이 이름이어야 한다.
- 지금 저장소에 있는 검사 대상은 문서(`docs/`, `openspec/`), 점검 스크립트(`tools/`), Terraform(`infra/`)뿐이다. 서비스·화면·계약 코드는 아직 없다.
- 확인한 외부 사실(2026-10-30, GitHub API):
  - `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`(2026-07-20)
  - `actions/setup-node` v7.1.0 = `949feb2413d6458794dcd2491c4babbbce0c15c1`(2026-10-08)
  - `hashicorp/setup-terraform` v4.0.1 = `dfe3c3f87815947d99a8997f908cb6525fc44e9e`(2026-05-12)
  - 셋 다 게시 3일이 지났다.
- Renovate 설정 키 `minimumReleaseAge`, `semanticCommits`, `extends`와 프리셋 `helpers:pinGitHubActionDigests`가 있다(Renovate 문서와 소스, 2026-10-30 확인). 기본 가지(`develop`)는 따로 적지 않아도 Renovate가 처리한다.

## Goals / Non-Goals

**Goals:**

- 필수 검사 셋을 낼 워크플로를 둔다. 그래야 GitHub 설정 적용 5단계가 막히지 않는다.
- 바뀐 범위 고르기, 가지 규칙, 병합 결과 트리, 워크플로 규칙을 각각 시험할 수 있는 스크립트로 만든다. 워크플로는 이 스크립트를 부르기만 한다.

**Non-Goals:**

- 릴리스·핫픽스 워크플로(`release.yml`, 릴리스 봇 앱이 있어야 한다), 승격 워크플로, 야간 성능 잡, 이미지 빌드·서명(0.1.5)
- 화면·서비스·계약·데이터 잡(그 코드가 생기는 변경에서 더한다. `changes`는 그 범위를 지금부터 고른다)
- 보안 검사 게이트(gitleaks·Semgrep·CodeQL, wbs 0.1.4)
- 가상 팀별 열린 작업 가지 수 경고와 `develop` 병합 방식 주간 점검(GitHub API가 필요하다. 원격이 생긴 뒤 별도 변경)

## Decisions

1. **스크립트가 판단하고 워크플로는 부르기만 한다.** 판단은 모두 `tools/ci/*.mjs`(의존성 없는 Node)에 두고 시험한다. 워크플로 YAML에는 조건 분기를 최소로 둔다. 원격 없이도 로컬에서 시험할 수 있기 때문이다.
2. **바뀐 범위(`changes.mjs`)**
   - 범위: `docs`(`docs/`, `openspec/`, `.claude/`, `tools/doc-check/`, 그리고 문서 점검이 읽는 파일인 `tools/`와 점으로 시작하는 폴더 밖의 `.md`·`.yaml`·`.json`·`.csv`), `contracts`(`docs/api/`, `packages/contracts/`), `js`(`apps/`, `services/`, `packages/`), `data`, `infra`, `deploy`, `loadtest`, `tools`, `ci`(`.github/`)
   - 넓히기: `packages/platform/`·`packages/contracts/`·`docs/api/`·뿌리 작업 공간 파일(`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`)이 바뀌면 `js_all`을 켠다(기대는 배포 단위 전부, devops §3.1 2번). `ci.yml`·`changes.mjs`가 바뀌면 모든 범위를 켠다(검사 절차 자체가 바뀜).
   - 실패: `git diff`가 실패하거나 비교 기준이 없으면 모든 범위를 켠다(D-T47 ④).
   - 비교 기준: PR은 대상 가지와의 병합 기준(`base...head`), 푸시는 `github.event.before`. 새 가지의 첫 푸시처럼 `before`가 없으면 전체를 돈다.
   - 옮긴 파일: `git diff --no-renames`로 옛 경로와 새 경로를 모두 센다. 이름 바꾸기로 보면 새 경로만 나와 옛 경로의 범위가 빠진다(구현 중 재현 시험으로 확인, 추천 적용 2026-10-31).
   - 지운 파일(옮긴 파일의 옛 경로 포함)이 있으면 `docs`도 켠다. 문서가 그 파일을 링크했을 수 있기 때문이다(코드 리뷰, 추천 적용 2026-10-31).
   - 출력: `$GITHUB_OUTPUT`에 범위마다 `true`/`false`. 로컬에서는 JSON을 찍는다.
3. **가지 규칙(`branch-policy.mjs`)**
   - PR 정보는 셸에 끼워 넣지 않고 `GITHUB_EVENT_PATH`의 사건 파일에서 읽는다. PR 제목·본문·가지 이름을 `${{ }}`로 `run:`에 넣으면 명령 주입이 되기 때문이다.
   - 검사: 가지 쌍(§2.2.6의 허용 목록, `promote/*`·`calendar/*` 포함), PR 제목(형식·허용 종류·`BREAKING CHANGE`와 `!`), 빌드 절차 변경 PR에 `.github/workflows/` 밖의 경로가 섞였는지(ADR-0169).
   - 경고만: 작업 가지가 3일을 넘김(가지에만 있는 가장 오래된 커밋 시각 기준).
   - `pull_request`의 `edited` 사건에도 돌아, 제목을 고치면 다시 판정한다(D-T41 ⑤).
4. **병합 결과 트리(`check-merge-tree.mjs`)**: `git merge-tree --write-tree <대상> <후보>`가 충돌 없이 끝나고, 그 트리가 후보 커밋의 트리와 같아야 한다. `main`으로 가는 PR에서만 돈다(잡 이름 `merge-tree`).
5. **워크플로 검사(`check-workflows.mjs`)**: 줄 단위로 본다(YAML 해석기를 의존성으로 들이지 않는다).
   - `uses:`는 같은 저장소 경로(`./`)이거나 `<소유자>/<저장소>[/경로]@<40자리 SHA>`
   - `pull_request_target` 금지, 맨 위 `permissions:` 필수
   - `${{ github.event.pull_request.title }}`·`body`·`github.head_ref` 같은 사용자 입력을 워크플로에 쓰지 않는다
   - `actions/checkout`마다 `persist-credentials: false`, 잡마다 `timeout-minutes`(재사용 워크플로를 부르는 잡은 그 워크플로가 정한다). 결정 6을 사람이 아니라 검사가 지키게 한다(추천 적용 2026-10-31)
6. **토큰과 체크아웃**: Node 판은 뿌리의 `.nvmrc` 한곳에 두고 `setup-node`가 읽는다(코드 리뷰, 추천 적용 2026-10-31). 모든 워크플로 맨 위에 `permissions: contents: read`를 둔다. `actions/checkout`은 `persist-credentials: false`로 쓴다. 같은 PR의 앞선 실행은 취소한다(concurrency). 잡마다 시간 상한을 둔다.
7. **유형별 검사는 재사용 워크플로로 둔다(추천 적용 2026-10-31)**: devops §3.1의 표대로 `docs-check.yml`·`iac-check.yml`, 그리고 점검 스크립트용 `tools-check.yml`을 `workflow_call`로 두고 `ci.yml`의 잡 `docs-check`·`tools-check`·`iac-check`가 같은 저장소 경로로 부른다. D-T47 ③의 'iac-check만 돈다'와 이름이 맞는다.
   - `ci.yml`은 `pull_request`의 `edited`에도 돈다. 대상 가지를 바꾸면 새 대상과 견줘 범위를 다시 고르게 하려는 것이다(코드 리뷰, 추천 적용 2026-10-31).
   - `docs-check.yml`: 문서 점검 도구(Python 3, 러너에 있는 것)와 그림 검사 의존성(`npm ci --ignore-scripts --prefix tools/doc-check/mermaid`), OpenSpec 검증(`pnpm exec openspec validate --all`)을 돌린다. 이것으로 wbs 0.1.3의 CI 연결을 함께 한다. pnpm은 `package.json`의 `packageManager`(지금 `pnpm@12.16.0`)를 읽어 `npm install --global`로 받는다. 판을 한곳에만 둬 Renovate가 올릴 때 어긋나지 않게 한다(코드 리뷰, 추천 적용 2026-10-31). 이 패키지의 설치 스크립트가 실행 파일을 놓으므로 이 한 줄만 `--ignore-scripts`를 붙이지 않는다(pnpm 문서의 npm 설치, 2026-10-31 확인).
   - `tools-check.yml`: `tools/ci` 시험과 워크플로·CODEOWNERS·`workspace:` 검사. 범위 `tools`·`ci`·`infra`(팀 목록)·`js`(`package.json`) 가운데 하나가 켜지면 돈다.
8. **`iac-check.yml`**: `hashicorp/setup-terraform`(판 1.16.2, 래퍼 끔), `terraform fmt -check -recursive infra`, 스택마다 `init -backend=false -lockfile=readonly`와 `validate`. 이 액션을 Terraform의 Actions 허용 목록 기본값에 더한다.
9. **`ci-summary`**: `needs`의 모든 잡 결과를 `tools/ci/ci-summary.mjs`가 보고, 실패나 취소가 하나라도 있으면 실패한다. 건너뛴 잡은 실패가 아니다. 그래서 문서만 바꾼 PR도 필수 검사가 '대기'로 남지 않는다(D-T47 ①). 결과를 읽지 못하면 통과로 두지 않는다.
10. **`changes` 잡이 실패해도 유형별 잡은 돈다**: 조건을 `!cancelled() && (changes가 성공하지 못함 || 그 범위가 켜짐)`으로 둔다. 범위를 고르지 못하면 전체를 돈다는 원칙(D-T47 ④)을 스크립트 안의 실패뿐 아니라 잡 자체의 실패에도 건다. 이때 `ci-summary`는 `changes`의 실패로 실패하므로, 범위 스크립트가 고장 난 채로 병합되지는 않는다.

## Risks / Trade-offs

- [GitHub에서 실제로 돌려 보지 못함] → 스크립트는 로컬 시험으로, 워크플로는 규칙 검사와 YAML 읽기로만 확인한다. 원격을 만든 뒤 첫 PR에서 D-T47·D-T41을 실제로 돌려 본다.
- [줄 단위 워크플로 검사의 한계] → 여러 줄 문자열 안의 `uses:` 같은 드문 꼴은 놓칠 수 있다. 조직 정책의 SHA 고정 요구(`sha_pinning_required`)가 GitHub 쪽에서 한 번 더 막는다.
- [빌드 절차 변경 PR을 따로 하라는 규칙의 불편] → 워크플로와 그것이 부르는 스크립트를 함께 바꿀 때는 스크립트 PR을 먼저 넣고 워크플로 PR을 뒤에 넣는다. 이 첫 변경은 원격이 없어 `develop`에 바로 커밋하므로 이 규칙을 받지 않는다.
- [가상 팀별 작업 가지 수 경고 없음] → GitHub API가 있어야 한다. 원격을 만든 뒤 별도 변경으로 더한다.
- [병합 결과 트리 검사가 낡을 수 있음] → PR이 열린 뒤 `main`이 움직이면 그 PR의 `merge-tree` 결과는 다시 돌지 않는다. 규칙 세트의 '최신 가지 요구'(strict)는 쓰지 않는다. 릴리스 가지는 `develop`에서 나오는데 `main`의 병합 커밋은 `develop`에 들어가지 않아(역병합은 릴리스 가지를 넣는다) 매 릴리스마다 `main`을 다시 병합해야 하고, 그러면 데모에서 검증한 후보 커밋이 바뀐다. 대신 `main`에는 릴리스 봇만 병합하고, 마무리 워크플로(`release.yml`, 이번 범위 밖)가 병합 직전에 같은 스크립트로 다시 검사한다(devops §3.1 표).
- [PR의 스크립트로 PR을 검사함] → `pull_request` 사건은 PR 쪽 코드를 돌리므로, PR이 `tools/ci`를 고쳐 검사를 통과시킬 수 있다. 공개 저장소의 포크 PR은 읽기 토큰만 받고, 병합은 쓰기 권한이 있는 사람만 하며, 그 변경은 `tools/ci`의 CODEOWNERS 검토 대상이다. 검사 스크립트를 기본 가지에서 따로 받아 돌리는 방식은 스크립트를 고치는 PR이 자기 변경을 시험하지 못하게 해서 쓰지 않는다.

## Migration Plan

- 원격 저장소를 만들고 밀어 넣으면 이 워크플로가 첫 PR부터 돈다. 그다음 GitHub 설정을 전체 적용한다(스택 안내서 5단계).
- 되돌리기: 워크플로 파일을 지우면 된다. 다만 규칙 세트를 적용한 뒤에는 필수 검사가 오지 않아 PR이 막히므로, 규칙 세트를 먼저 내린다.
