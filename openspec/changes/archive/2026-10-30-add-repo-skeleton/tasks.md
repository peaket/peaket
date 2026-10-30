# Tasks

## 1. 폴더 뼈대

- [x] 1.1 `apps/`, `services/`, `packages/`, `data/`, `infra/`에 `README.md`를 둔다. 담는 것 한두 줄과 정본 링크(docs/architecture.md §10, 그 폴더를 채우는 WBS)만 적는다. 확인: 다섯 파일이 있고 `python tools/doc-check/check_all.py`가 오류 0이다.

## 2. 팀 목록과 CODEOWNERS

- [x] 2.1 `infra/stacks/global/github/teams.json`에 가상 팀 아홉(이름표 `queue`, `purchase`, `ticketing`, `commerce`, `frontend-platform`, `platform`, `data`, `bot-detection`, `architecture`와 표시 이름, 팀 유형)을 둔다. 확인: JSON으로 읽히고 docs/planning/01 §3.3의 아홉과 같다.
- [x] 2.2 `.github/CODEOWNERS`를 design.md 결정 3의 순서로 쓴다(조직 이름은 계획 리뷰에서 정한 것, 추천 `peaket`). 확인: 2.3의 검사가 통과한다.
- [x] 2.3 `tools/ci/check-codeowners.mjs`(CODEOWNERS의 팀이 모두 `teams.json`에 있는지, 줄마다 주인이 있는지, `*` 줄이 맨 앞인지 본다)와 그 시험을 만든다. 시험은 임시 폴더에 맞는 예와 틀린 예를 두고 스크립트를 바깥에서 돌린다. 확인: `node --test "tools/ci/*.test.mjs"`가 통과하고, 저장소의 CODEOWNERS로 돌리면 종료 코드 0이다.
- [x] 2.4 정본에 반영한다: docs/devops.md §2.3에 '팀 목록은 `teams.json` 한 곳'을, docs/architecture.md §10에 뿌리 작업 공간 파일(`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`)의 주인(플랫폼 팀)을 적는다. 확인: 문서 점검 오류 0이다.

## 3. GitHub 설정 Terraform

- [x] 3.1 `infra/modules/github`에 저장소 하나의 git flow 규칙 세트 넷(`main`, `develop`, `release/*`·`hotfix/*`, 태그 `v*`)을 design.md 결정 7대로 만든다. 필수 검사 이름, 릴리스 봇 앱 ID(없으면 우회 없음), 필수 승인 수, 코드 주인 검토는 변수다. 확인: `terraform fmt -check -recursive infra`가 통과한다.
- [x] 3.2 `infra/stacks/global/github`에 판 고정(`~> 1.16`, 제공자 `~> 6.13`), 제공자 설정, 변수, 저장소 4개와 기본 가지, 모듈 호출(`peaket`, `.github`)과 `peaket-gitops`의 `main` 규칙 세트, 팀과 저장소 권한, 환경 넷과 배포 가지, Actions 조직 정책·워크플로 권한·OIDC 주체 키를 만든다. `terraform.tfvars.example`을 두고, 뿌리 `.gitignore`에 `.terraform/`, `*.tfstate`, `*.tfstate.*`, `*.tfvars`(예시 파일 제외)를 더한다. 확인: `terraform init -backend=false`와 `terraform validate`가 통과한다.
- [x] 3.3 제공자 잠금 파일을 Linux·Windows·macOS(arm64) 해시로 만들어 커밋 대상에 둔다(`terraform providers lock -platform=linux_amd64 -platform=windows_amd64 -platform=darwin_arm64`). 확인: `.terraform.lock.hcl`에 세 플랫폼의 해시가 있다.
- [x] 3.4 `infra/stacks/global/github/README.md`에 적용 순서(design.md 'Migration Plan')와 필요한 변수·토큰을 적는다. 정본 내용은 옮기지 않고 devops §2.2.6·§2.3을 가리킨다. 확인: 문서 점검 오류 0이다.
- [x] 3.5 정본에 반영한다: docs/devops.md §2.2.6에 필수 검사 이름(`ci-summary`, `branch-policy`, `main`의 `merge-tree`)을, §9.1에 'GitHub 설정 스택은 처음에 로컬 상태로 적용하고 wbs 0.4.2에서 S3로 옮긴다'를 적는다. 확인: 문서 점검 오류 0이다.

## 4. `workspace:` 표기 검사

- [x] 4.1 `tools/ci/check-workspace-protocol.mjs`를 만든다. 뿌리부터 `package.json`을 찾아(`node_modules`·`.git` 제외) 네 의존성 칸의 `@peaket/*` 판이 `workspace:`로 시작하지 않으면 파일과 이름을 적고 실패한다. 확인: 저장소에서 돌리면 종료 코드 0이다.
- [x] 4.2 시험을 만든다: `workspace:` 판은 통과, `^1.0.0` 판은 실패, 다른 범위(`@other/*`)는 무시, `node_modules` 안은 건너뜀. 확인: `node --test "tools/ci/*.test.mjs"`가 통과한다.

## 5. 통합 확인과 기록

- [x] 5.1 전체를 한 번에 확인한다: `node --test "tools/ci/*.test.mjs"`, `terraform fmt -check -recursive infra`, `terraform validate`, `python tools/doc-check/check_all.py`(오류 0), 새 파일의 줄바꿈 LF. 확인: 모두 통과한다.
- [x] 5.2 기록한다: docs/review/consistency-review.md에 R 행, wbs 0.1.1에 '로컬 부분 끝, 적용은 조직 뒤'(CSV 포함), docs/00-summary.md §4. 확인: 문서 점검 오류 0이다.

## 6. 저장소 둘로 바꾸기(ADR-0169, 소유자 결정 2026-10-30)

- [x] 6.1 `infra/stacks/global/github`를 저장소 둘(`peaket` 공개·`develop`, `peaket-bots` 비공개·`main`)로 고친다. 규칙 세트는 `peaket`에만, 팀은 모두 `peaket`에 쓰기, 플랫폼 팀은 `peaket-bots`에도 쓰기. `peaket-gitops`의 `main` 규칙 세트를 없앤다. 안내서의 적용 순서도 고친다. 확인: `terraform fmt -check -recursive infra`와 `terraform validate`가 통과한다.
- [x] 6.2 `deploy/`·`loadtest/`에 안내 파일을 두고, CODEOWNERS에 `/deploy/`·`/loadtest/`(플랫폼 팀)를 더한다. 확인: `node --test "tools/ci/*.test.mjs"`와 CODEOWNERS 검사가 통과하고 문서 점검 오류 0이다.

## 7. 코드 리뷰 반영(2026-10-30)

- [x] 7.1 `workspace:` 검사가 `overrides`·`resolutions`·`pnpm.overrides`, `npm:@peaket/…` 별칭, `pnpm-workspace.yaml`의 `@peaket/` 이름도 막는다. 재현 시험을 먼저 만들어 실패를 본 뒤 고친다. 확인: `node --test "tools/ci/*.test.mjs"`가 통과한다.
- [x] 7.2 `workspace:` 검사가 git이 추적하는 파일만 본다(git 밖에서는 폴더를 훑는다). 확인: 같은 시험이 통과하고, 추적하지 않는 폴더의 `package.json`은 보지 않는다.
- [x] 7.3 CODEOWNERS 검사가 뜻이 같은 경로(`/x`, `/x/`, `/x/**`)를 중복으로 잡는다. 재현 시험을 먼저 만든다. 확인: 같은 시험이 통과한다.
- [x] 7.4 Terraform: 규칙 세트 모듈이 환경을 먼저 만들게 기다린다. 필수 검사는 GitHub Actions(앱 ID 15368)에서 온 것만 받는다. 봇 저장소는 스위치(`bots_repository_enabled`, 기본 꺼짐)로 만든다. 확인: `terraform fmt -check -recursive infra`와 `terraform validate`가 통과한다.
- [x] 7.5 정본과 안내서에 반영한다(devops §2.2.6·§4.4, 스택 README). 확인: 문서 점검 오류 0이다.

## Workflow follow-up

- 대조: `/opsx:verify`(OpenSpec 명령은 `pnpm exec openspec`으로 부른다).
- 브라우저 확인: 해당 없음(화면이 없다). `browser-check.md`에 '해당 없음'과 까닭만 적는다.
- 코드 리뷰: 원격 저장소가 없어 PR 대신 `/code-review`로 한다.
- 보관: `/opsx:archive`. 명세를 건너뛴 변경이라 `openspec/specs/`에 합칠 것은 없다.
- 조직이 생긴 뒤 별도 변경으로: 조직과 저장소 만들기, `main`·`develop` 밀어 넣기(공개 게시라 소유자 확인), wbs 0.1.2의 CI가 한 번 돈 뒤 전체 적용(design.md 'Migration Plan').
