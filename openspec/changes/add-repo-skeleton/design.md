# 설계: 저장소 뼈대와 GitHub 설정 코드

## Context

- 이 저장소(`D:\ticketpass`)가 그대로 모노레포 `peaket`의 뿌리가 된다(ADR-0165). 지금은 문서, `tools/`, `openspec/`, 뿌리 `package.json`·`pnpm-workspace.yaml`만 있다. 원격 저장소와 GitHub 조직은 없고, `develop`에 바로 커밋한다(devops §2.2.5 예외).
- 이 PC에는 Terraform 1.16.2, gh 2.101.0(로그인됨), Node 24.18이 있다. AWS 계정과 Terraform 상태 버킷(wbs 0.4.2)은 아직 없다.
- 정본이 정한 것: 규칙 세트의 내용(devops §2.2.6), 설정 목록(§2.3), 폴더와 주인 팀(architecture §10), 환경(§5.1), Actions·토큰·OIDC(§4.5), 상태와 버전 고정(§9.1). 이 설계는 그것을 어떤 파일과 자원으로 옮길지만 정한다.
- 확인한 외부 사실(2026-10-30): Terraform GitHub 제공자 최신은 v6.13.0(2026-07-08)이다. 규칙 세트의 `allowed_merge_methods`, 우회 주체 `Integration`, Actions 조직 권한의 `sha_pinning_required`, 조직 OIDC 주체 템플릿의 `include_claim_keys`, 조직 워크플로 권한의 `default_workflow_permissions`가 그 판의 문서에 있다.

## Goals / Non-Goals

**Goals:**

- 조직이 생기면 `terraform apply`만으로 정본의 GitHub 설정이 서도록 코드를 갖춘다.
- 폴더 주인(CODEOWNERS)과 Terraform 팀 목록이 한 곳(팀 목록 파일)에서 나오게 하고, 둘이 어긋나면 시험이 잡는다.
- `workspace:` 표기 검사를 CI에 붙이기만 하면 되게 만든다.

**Non-Goals:**

- GitHub 조직·저장소를 실제로 만들거나 설정을 적용하는 일(조직이 생긴 뒤 별도 변경).
- CI 워크플로(`ci.yml`, `branch-policy`, 병합 결과 트리 검사)는 wbs 0.1.2다. 여기서는 필수 검사 이름만 정한다.
- 릴리스 봇 GitHub 앱 만들기(앱은 웹에서 소유자가 만든다. 여기서는 앱 ID를 받는 변수만 둔다).
- 비공개 `peaket-bots`의 첫 내용(wbs 1.2.2), `deploy/`·`loadtest/`의 실제 내용(wbs 0.4.4, 1.2.1).
- Terraform 원격 상태(S3 백엔드)는 wbs 0.4.2에서 붙인다.

## Decisions

1. **폴더 자리는 짧은 안내 파일로 만든다.** `apps/`, `services/`, `packages/`, `data/`, `infra/`에 `README.md`를 두고, 무엇을 담는지 한두 줄과 정본 링크(architecture §10, 해당 WBS)만 적는다. 내용을 정본에서 옮겨 적지 않는다(문서는 한 흐름).
   - 대안: `.gitkeep`. 저장소를 처음 보는 사람이 폴더의 뜻을 모른다. 기각.
2. **팀 목록은 파일 하나가 정본이다.** `infra/stacks/global/github/teams.json`에 가상 팀 아홉(이름표, 표시 이름, 팀 유형)을 둔다. Terraform은 `jsondecode(file(...))`로 읽어 팀을 만들고, CODEOWNERS 시험은 같은 파일을 읽어 CODEOWNERS의 팀이 모두 그 목록에 있는지 본다.
   - 팀 이름표: `queue`, `purchase`, `ticketing`, `commerce`, `frontend-platform`, `platform`, `data`, `bot-detection`, `architecture`(docs/planning/01 §3.3의 아홉).
   - 대안: Terraform이 CODEOWNERS 파일을 저장소에 직접 쓰기(`github_repository_file`). 봇 커밋이 PR 없이 `develop`에 들어가 규칙 세트와 부딪힌다. 기각.
3. **CODEOWNERS는 마지막에 맞는 줄이 이긴다는 규칙을 따라, 넓은 것에서 좁은 것 순서로 쓴다.**
   - `*` → 아키텍처 팀. 문서 폴더·`tools/`·`openspec/`·계약 원본(`docs/api/`)이 이 팀이다.
   - `/apps/`·`/packages/` → 프론트엔드 플랫폼. 그 안의 `/apps/widgets/queue/` → 대기열, `/apps/widgets/purchase/` → 구매, `/packages/platform/` → 플랫폼, `/packages/contracts/` → 아키텍처.
   - `/services/` → 플랫폼(표에 없는 작업자 기본값). 그 안의 대기열·구매·발권·봇 탐지·데이터 서비스는 각 팀이다(architecture §10 표 그대로).
   - `/data/` → 데이터, `/infra/`·`/.github/`·`/perf-ledger/` → 플랫폼.
   - 뿌리의 작업 공간 설정(`/package.json`, `/pnpm-workspace.yaml`, `/pnpm-lock.yaml`) → 플랫폼. 공급망 설정(devops §4.4)의 주인이라서다(추정, architecture §10에 행이 없음).
   - 커머스 팀의 `core-svc` shop 모듈 줄은 그 폴더가 생기는 변경에서 더한다. 새 서비스도 주인이 플랫폼이 아니면 그 서비스를 만드는 변경이 줄을 더한다.
4. **Terraform 구성은 스택 하나와 모듈 하나다**(devops §9.1의 `modules/github`, `stacks/global/github`).
   - 모듈 `infra/modules/github`: 저장소 하나에 git flow 규칙 세트 넷(`main`, `develop`, `release/*`·`hotfix/*`, 태그 `v*`)을 건다. 처음에는 `peaket`과 `.github`에 두 번 불렀고, ADR-0169 뒤에는 `peaket`에만 부른다. 다른 저장소가 생기면 다시 쓸 수 있게 모듈로 둔다.
   - 스택: 저장소 둘(ADR-0169), 기본 가지, 팀과 저장소 권한, 환경, 조직 Actions·워크플로 권한·OIDC 주체 키. 비공개 `peaket-bots`에는 규칙 세트를 걸지 않는다(무료 등급, devops §2.2.5). 처음 계획의 `peaket-gitops` `main` 규칙 세트는 저장소와 함께 없앴다.
   - 대안: 스택 하나에 모두 풀어 쓰기. 같은 규칙 세트를 두 번 베껴 쓰게 된다. 기각.
5. **판 고정**: `required_version = "~> 1.16"`, 제공자 `integrations/github` `~> 6.13`(정본의 하한 6.10.0 이상). 제공자 잠금 파일(`.terraform.lock.hcl`)은 Windows·Linux·macOS(arm64) 해시를 담아 커밋한다(`terraform providers lock -platform=…`). CI 러너는 Linux라서다.
6. **상태는 지금은 로컬, wbs 0.4.2에서 S3로 옮긴다.**
   - 지금 코드에는 백엔드 블록을 두지 않는다(기본은 로컬). 0.4.2에서 `backend.tf`(S3, `use_lockfile`)를 더하고 `terraform init -migrate-state`로 옮긴다.
   - 조직 설정은 CI보다 먼저 서야 하고(0.1.1 → 0.1.2), 상태 버킷은 기반 작업 순서상 뒤에 온다(docs/planning/01 '증명 순서'). 그래서 처음 적용은 로컬 상태로 한다. 상태 파일(`*.tfstate*`)은 `.gitignore`에 넣는다.
   - 대안: 부분 백엔드 설정(`backend "s3" {}`)을 지금 두기. 버킷이 없어 적용할 수 없다. 기각.
7. **규칙 세트의 값**(devops §2.2.6)
   - 필수 검사 이름을 여기서 정한다: `ci-summary`, `branch-policy`(ADR-0165), `main`에는 `merge-tree`도 둔다(병합 결과 트리 검사, §2.2.4). wbs 0.1.2의 잡 이름은 이것과 같아야 한다.
   - `main`: PR 필수, 병합 방식 병합 커밋만, 필수 검사 셋, 병합 전 `demo` 환경 배포 성공, 강제 푸시·삭제 금지.
   - `develop`: PR 필수, 병합 방식 스쿼시와 병합 커밋, 필수 검사 둘, 강제 푸시·삭제 금지.
   - `release/*`·`hotfix/*`: 만들기는 릴리스 봇만, PR 필수, 강제 푸시 금지. 태그 `v*`: 만들기·바꾸기·지우기는 릴리스 봇만.
   - 필수 승인 수 0, 코드 주인 검토 요구 끔(1인 기간, devops §2.3). 변수로 두어 실제 팀이 생기면 올린다.
   - 릴리스 봇 우회는 앱 ID 변수(`release_bot_app_id`)가 있을 때만 넣는다(없으면 우회 주체 없음).
   - 스쿼시 커밋의 제목·본문은 PR 제목·본문으로 둔다(§2.2.5 '스쿼시 커밋 메시지는 PR 제목').
8. **환경과 배포 가지**(devops §5.1, §2.2.6 릴리스 봇): `demo`는 `release/*`·`hotfix/*`, `staging`은 `release/*`·`hotfix/*`(측정 캠페인 수동), `prod`는 `main`만, `release`는 `develop`·`release/*`·`hotfix/*`·`main`. `prod`의 검토자는 소유자이고, 1인 기간이라 자기 승인을 막지 않는다.
9. **Actions 조직 정책**(devops §4.5): `allowed_actions = "selected"`, GitHub 소유 액션 허용, 마켓플레이스 인증 액션 일괄 허용은 끔, 제3자 액션 허용 목록은 비워 두고 0.1.2에서 쓰는 것만 더한다. `sha_pinning_required = true`. 워크플로 토큰 기본 권한은 읽기, PR 승인 권한 없음. OIDC 주체 키는 `repo`, `context`, `job_workflow_ref`.
10. **`workspace:` 표기 검사는 의존성 없는 Node 스크립트다.** `tools/ci/check-workspace-protocol.mjs`가 뿌리부터 `package.json`을 찾아(`node_modules`·`.git` 제외) `dependencies`·`devDependencies`·`peerDependencies`·`optionalDependencies`의 `@peaket/*` 판이 `workspace:`로 시작하지 않으면 파일과 이름을 적고 실패한다. 시험은 Node 내장 시험 실행기(`node --test`)로, 임시 폴더에 맞는 예와 틀린 예를 만들어 바깥에서 돌린다(내부 함수를 공개하지 않는다).
    - 대안: ESLint 규칙. 아직 ESLint 설정이 없다(wbs 0.6.4). 기각.

## Risks / Trade-offs

- [조직 이름이 정해지지 않음] → CODEOWNERS는 추천 이름 `peaket`으로 쓴다(2026-10-30 조회 때 비어 있음). 다른 이름으로 정하면 CODEOWNERS의 `@peaket/`만 바꾸면 된다. Terraform은 변수(`github_owner`)라 바꿀 곳이 없다.
- [필수 검사 이름이 0.1.2의 잡 이름과 어긋남] → 규칙 세트가 오지 않는 검사를 기다려 모든 PR이 막힌다. 이름을 여기 정하고, 규칙 세트는 0.1.2의 CI가 한 번 돈 뒤에 적용한다(아래 적용 순서).
- [로컬 상태 파일 분실] → 이 스택의 자원은 모두 `terraform import`로 되살릴 수 있다. 0.4.2에서 S3로 옮긴다.
- [무료 등급 한계] → 비공개 `peaket-bots`에는 규칙 세트가 없다. 봇 시뮬레이터만 담고 운영 경로에 들지 않는 저장소라 정본이 받아들였다(devops §2.1, ADR-0169).
- [조직 Actions 정책이 너무 좁음] → 0.1.2에서 쓰는 액션을 허용 목록에 더하기 전에는 그 워크플로가 실패한다. 0.1.2의 작업에 넣는다.
- [CODEOWNERS 줄이 실제 폴더보다 앞섬] → 아직 없는 폴더를 가리켜도 GitHub는 오류로 보지 않는다. 팀이 없으면 오류이므로, 팀은 시험으로 맞춘다.

## Migration Plan

조직이 생긴 뒤(별도 변경, 소유자 진행):

1. 소유자가 GitHub 조직을 만들고, 조직 관리 권한이 있는 토큰으로 `GITHUB_TOKEN`을 둔다(토큰은 소유자가 다룬다).
2. `terraform apply -target`으로 저장소 넷만 만든다.
3. 이 저장소의 `main`·`develop`을 원격 `peaket`에 밀어 넣는다. 공개 게시라 그때 소유자에게 다시 확인한다.
4. wbs 0.1.2의 CI가 한 번 돈 뒤 전체 `terraform apply`(기본 가지, 규칙 세트, 팀, 환경, Actions 정책)를 한다.
5. wbs 0.4.2에서 `backend.tf`를 더하고 상태를 S3로 옮긴다.

되돌리기: 규칙 세트·환경·팀은 `terraform destroy -target`으로 지운다. 저장소는 `archive_on_destroy = true`라 지우지 않고 보관 처리된다.

## Open Questions

- GitHub 조직 이름: 추천은 `peaket`이다. 계획 리뷰 때 정하면 CODEOWNERS에 그 이름을 쓴다. 접근 방식과 작업 목록은 바뀌지 않는다.
- 릴리스 봇 GitHub 앱의 ID: 앱을 만드는 때(릴리스 워크플로, wbs 0.1.2 이후)에 변수로 넣는다.
