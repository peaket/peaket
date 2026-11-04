# tools/ci — CI가 부르는 점검 스크립트

공용 CI의 판단은 모두 이 폴더의 스크립트가 합니다. 워크플로(`.github/workflows/`)는 이 스크립트를 부르기만 합니다. 그래서 원격 저장소 없이도 로컬에서 같은 판단을 시험할 수 있습니다(docs/devops.md §3.1, openspec 변경 `add-ci-foundation`). 모두 의존성 없는 Node 스크립트이고 Node 24에서 돌립니다.

| 스크립트 | 하는 일 | 부르는 곳 |
| --- | --- | --- |
| `changes.mjs` | 바뀐 파일로 검사 범위(`docs`, `contracts`, `js`, `js_all`, `data`, `infra`, `deploy`, `loadtest`, `tools`, `ci`, `kind`, `image`, `specs`, `specs_full`)를 고릅니다. `specs`는 명세(`specs/`)·검사 도구(`tools/spec-check/`)·`spec-check.yml`이 바뀌었을 때, `specs_full`은 검사 목록 `specs/specs.json`이 적은 관련 ADR이 바뀌었을 때입니다(규칙 모델 검사, wbs 0.9.1). `kind`는 로컬 클러스터 정의·공용 차트·`tools/local`과, 서비스 이미지에 드는 것 전부(`packages/platform`·`packages/config`·작업 공간 파일 `package.json`·잠금 파일, v0 배포의 `services/v0-monolith`·`services/pg-simulator`·`services/payment-svc`·`deploy/envs/local`·`tools/ci/verify-native-binding.mjs`)가 바뀌었을 때입니다(무거운 잡이라 화면·문서 변경에는 고르지 않습니다). `image`는 이미지가 있는 배포 단위와 그 Dockerfile이 담는 패키지, 작업 공간 파일, `.dockerignore`·`.nvmrc`, `build-image.yml`과 그 스크립트가 바뀌었을 때입니다(이미지 빌드 시험, docs/devops.md §3.2). 비교 기준이 없거나 git이 실패하면 전체를 고릅니다(D-T47) | `ci.yml`의 `changes` |
| `ci-summary.mjs` | 앞선 잡이 하나라도 실패하거나 취소되면 실패합니다. 건너뛴 잡은 실패가 아닙니다 | `ci.yml`의 `ci-summary`(필수 검사) |
| `fork-guard.mjs` | 비밀이 필요한 단계의 포크 PR 건너뛰기 표시(§4.5, 기술 검토 낮음-010). 포크에서 온 PR이면 출력 `run=false`와 '포크 PR 건너뜀' 알림·잡 요약 줄을 남기고 실패하지 않습니다. 조직 안 PR·푸시에서 비밀이 빠졌으면 실패합니다. 비밀 값은 읽지 않고 있는지만 봅니다. 지금 PR에서 비밀을 쓰는 단계는 없습니다(로컬·CI의 AWS 흉내는 계정이 없습니다) | 비밀이 필요한 단계(앞으로) |
| `branch-policy.mjs` | 가지 쌍, PR 제목 형식, 빌드 절차 변경 PR에 다른 경로가 섞였는지를 봅니다. 같은 저장소의 릴리스·핫픽스·역병합 PR은 보호 가지에 아직 없는 새 커밋이 바꾼 파일만 섞임 검사를 합니다(이미 병합된 변경을 옮길 뿐입니다). 포크 PR은 바뀐 파일 전부를 봅니다. 작업 가지가 3일을 넘기면 경고합니다(§2.2.6, D-T41) | `branch-policy.yml`(필수 검사) |
| `branch-watch.mjs` | 경고만 하는 가지 점검 둘(§2.2.1·§2.2.6, D-T49). `count`는 작업 가지 PR마다 같은 저장소에서 열린 작업 가지 PR(`feature/*`·`bugfix/*`, 포크 제외)과 그 바뀐 파일을 GitHub API로 읽어 대상 가지(`origin/<대상>`)의 `.github/CODEOWNERS` 주인 팀마다 세고, 이번 PR의 팀 가운데 3개를 넘는 팀을 경고합니다. API를 읽지 못하면 그 사실만 경고합니다. `weekly`는 지난 8일 `origin/develop` 첫 부모 이력의 병합 커밋마다 들어온 가지(병합 PR의 머리 가지, 없으면 커밋 제목)를 보고 `release/*`·`hotfix/*`·`merge/*`가 아니면 경고하고 잡 요약에 표를 남깁니다. 둘 다 토큰의 `contents: read`·`pull-requests: read`만 씁니다 | `branch-policy.yml`(`count`), `branch-weekly.yml`(`weekly`) |
| `conventional.mjs` | Conventional Commits 제목 규칙(허용 종류, 형식, 호환을 깨는 표시). PR 제목 검사와 버전 계산이 함께 씁니다 | `branch-policy.mjs`, `release-plan.mjs` |
| `release-plan.mjs` | 릴리스·핫픽스 계획. `start`는 다음 판(SemVer, 0.y.z 규칙)·변경 기록·바뀐 배포 단위·버전을 올린 `package.json`을, `finish`는 태그·후보·역병합 대상과 `merge/*` 가지 이름을, `verify`는 `main` 병합 커밋의 두 번째 부모와 트리를 봅니다(§2.2.2~§2.2.5, D-T22·D-T23·D-T25·D-T41 ④) | `release.yml` |
| `contract-breaking.mjs` | 계약 깨짐 검사(docs/api/guidelines.md §1, D-T48). PR의 openapi·asyncapi를 대상 가지와 마지막 출시 태그(`vX.Y.Z` 최대)의 것과 견줍니다. OpenAPI는 `oasdiff breaking --fail-on ERR`, AsyncAPI는 채널·작업을 `asyncapi diff -t breaking`이, 메시지 본문을 oasdiff가 봅니다(본문은 `packages/contracts/scripts/asyncapi-messages.mjs`가 메시지마다 읽기 작업을 붙인 OpenAPI로 바꿉니다. AsyncAPI CLI 6.2.2는 3.0 본문 변경을 분류하지 않습니다). 수준·예외 파일은 `docs/api/breaking/`이고, 예외에는 이유가 있어야 하며 늘어나면 PR에 `breaking-approved` 라벨이 있어야 합니다(라벨은 사건 파일에서 읽습니다). `services`는 서비스 OpenAPI 차이(D-T38)이고 본체는 `service-openapi.mjs`입니다 | `contract-check.yml` |
| `service-openapi.mjs` | 서비스 OpenAPI 차이(D-T38). `services/<이름>/package.json`에 `openapi:emit`이 있는 서비스마다 문서를 뽑아(`pnpm --dir services/<이름> run openapi:emit`, 환경 변수 `OPENAPI_OUT`), `peaket.contractOperations`에 적은 계약 작업만 경로·메서드·매개변수·요청과 응답 본문의 모양으로 `docs/api/openapi.yaml`과 견줍니다. 목록이 없거나 문서를 못 만들면 실패합니다(규칙은 docs/devops.md §3.1 `contract-check.yml` 행). 계약 YAML은 계약 패키지의 `yaml`로 읽어 작업 공간 설치가 필요하고, 시험은 JSON 계약으로 설치 없이 돕니다 | `contract-breaking.mjs services` |
| `release-tags.mjs` | 출시 태그 규칙(`vX.Y.Z`)과 SemVer 정렬. `release-plan.mjs`와 `contract-breaking.mjs`가 함께 씁니다 | 스크립트 |
| `check-merge-tree.mjs` | 후보를 대상에 병합한 결과 트리가 후보의 트리와 같은지 봅니다(§2.2.4, D-T22) | `merge-tree.yml`(`main` 필수 검사) |
| `check-workflows.mjs` | 워크플로 규칙: 액션 SHA 고정, `pull_request_target` 금지, 맨 위 `permissions:`, 사용자 입력을 식에 쓰지 않기, 체크아웃의 `persist-credentials: false`, 잡마다 `timeout-minutes`(§4.5). `build-image.yml`의 빌드 잡은 잡 권한이 `contents: read`뿐이고 레지스트리 로그인·푸시·서명·출처 증명 단계가 없어야 합니다(D-T32 ①) | `tools-check.yml` |
| `image-build.mjs` | 이미지 빌드 잡의 본체(§3.1 `build-image.yml` ①). 플랫폼 하나를 BuildKit(`docker-container` 빌더, 이미지 다이제스트 고정)으로 빌드해 OCI 묶음과 다이제스트를 만들고(`--provenance=false --sbom=false`, 푸시 없음), 같은 이미지를 실어 네트워크 없이 스모크합니다 | `build-image.yml` |
| `image-smoke.mjs` | 이미지 안에서 그 이미지의 node로 돕니다. 플랫폼·아키텍처가 맞는지, 네이티브 모듈(`.node`)이 모두 열리는지 봅니다(arm64 러너 스모크) | `image-build.mjs` |
| `verify-native-binding.mjs` | 미리 빌드한 Kafka 바인딩 대조(§4.4, ADR-0176 결정 5). 설치가 끝난 파일 묶음에서 그 패키지를 찾아 고정 표의 다이제스트로 다시 받은 묶음을 견주고, 묶음과 설치된 `build/` 파일이 같은지 봅니다. 판을 올리면 고정 표부터 고칩니다 | 이미지 Dockerfile의 빌드 단계 |
| `check-codeowners.mjs` | `.github/CODEOWNERS`의 팀이 `teams.json`에 있는지, 첫 줄이 `*`인지, 같은 경로가 두 번 없는지 봅니다(§2.3) | `tools-check.yml` |
| `check-workspace-protocol.mjs` | `@peaket/*`을 `workspace:` 밖의 판으로 적은 곳을 막습니다(§4.4) | `tools-check.yml` |
| `trace-check.mjs` | 정본 ID 대조(docs/architecture.md §8.6의 5단계, ADR-0178). 범위 목록의 시험 ID마다 이름에 그 ID를 단 시험이 통과했는지 시험 보고서(vitest JSON, JUnit XML)로 봅니다. `X-T12`·`FR-073` 꼴은 가운데 `-`를 빼고 적은 이름(`FR073_…`)도 맞고, `S-T2`는 `S-T27`에 걸리지 않습니다. 통과한 시험이 없는 ID가 있으면 종료 코드 1입니다. ID는 시험 이름 자체에 답니다(`node --test`의 JUnit 보고서는 `describe` 이름을 싣지 않습니다). 같은 ID에 통과와 실패가 섞이면 통과로 세므로, 시험 실행 자체가 통과했는지는 따로 봅니다 | 단계를 끝낼 때(docs/PROGRESS.md 턴 규칙) |
| `records.mjs` | 공용 기록 표 맞추기(ADR-0190 결정 3). 커밋 본문의 정합 점검 행(`정합 점검:`으로 시작하는 R 행)과 BUILD_ORDER 체크로 docs/review/consistency-review.md R 표, docs/00-summary.md §4, docs/wbs/wbs.md·wbs.csv 상태 칸을 맞춥니다. `--check`는 고칠 것이 있으면 1, 읽기·실행 오류는 2, `--next-r`는 다른 갈래의 작업 가지까지 본 다음 R 번호. 지난 커밋의 잘못된 행과 겹친 번호는 경고하고 건너뜁니다. 갈래 1(루프)만 돌립니다 | 루프 턴(손으로) |
| `git-fixture.mjs` | 시험용 임시 git 저장소. 시험만 씁니다 | `*.test.mjs` |

## 로컬에서 돌리기

저장소 뿌리에서 실행합니다.

```bash
node --test "tools/ci/*.test.mjs"
```

```bash
node tools/ci/changes.mjs --base develop
```

```bash
node tools/ci/check-workflows.mjs
```

```bash
node tools/ci/check-codeowners.mjs
```

```bash
node tools/ci/check-workspace-protocol.mjs
```

```bash
node tools/ci/check-merge-tree.mjs --target main --candidate HEAD
```

```bash
node tools/ci/release-plan.mjs start --kind release --from develop
```

`release-plan.mjs`는 원격 가지를 `origin/…`으로 읽습니다(`finish`의 후보, 열린 `release/*`·`hotfix/*`). 결과는 `GITHUB_OUTPUT`이 있으면 그 파일에, 없으면 JSON으로 표준 출력에 냅니다. `--notes 파일`을 주면 변경 기록을, `--package-json 파일`을 주면 버전을 올린 `package.json`을 그 파일에 씁니다.

`branch-watch.mjs`는 GitHub API를 부릅니다. 로컬에서는 `GITHUB_REPOSITORY=peaket/peaket`과 읽기 토큰 `GITHUB_TOKEN`(공개 저장소는 없어도 되지만 호출 한도가 낮습니다)을 주고 `node tools/ci/branch-watch.mjs weekly`처럼 돌립니다. `count`는 PR 사건 파일도 읽습니다(`pull_request.number`, `head.ref`, `head.repo.full_name`, `base.ref`. `head.repo`가 없으면 포크로 보고 세지 않습니다). API 주소는 `GITHUB_API_URL`(없으면 `https://api.github.com`)입니다.

`branch-policy.mjs`는 GitHub가 주는 PR 사건 파일을 읽습니다. 로컬에서는 같은 모양의 JSON(`pull_request.title`, `body`, `head.ref`, `head.sha`, `base.ref`, `base.sha`)을 만들어 `GITHUB_EVENT_PATH`로 넘깁니다. `ci-summary.mjs`는 잡 결과를 `NEEDS` 환경 변수(JSON)로 받습니다.

- `node --test`에는 폴더가 아니라 따옴표로 감싼 글롭을 줍니다. Node 24는 폴더 이름을 파일로 읽습니다.
- 시험은 운영체제의 임시 폴더에 git 저장소를 만들고, 시험 프로세스가 끝날 때 지웁니다. 시험 시간은 1분 안팎입니다.

### 계약 깨짐 검사(`contract-breaking.mjs`)

도구는 판과 다이제스트를 고정한 공식 이미지(`tufin/oasdiff` v1.34.1, `asyncapi/cli` 6.2.2)를 `docker run --rm --network none`으로 부릅니다. 그래서 Docker가 있어야 하고(개발 PC는 Docker Desktop), 메시지 본문 변환이 `packages/contracts`의 `yaml`을 쓰므로 `pnpm install` 뒤에 돌립니다. 네트워크를 끊는 까닭은 AsyncAPI CLI가 실행 기록을 밖으로 보내려 하기 때문입니다. 이미지 판을 올릴 때는 `IMAGES`의 다이제스트를 Docker Hub에서 확인한 값으로 바꾸고 게시 뒤 3일을 기다립니다(docs/devops.md §4.4).

```bash
node tools/ci/contract-breaking.mjs --target develop --pull-request --labels '[]'
node tools/ci/contract-breaking.mjs services
```

알림(건너뛴 기준), `::warning`(oasdiff WARN), 실패를 차례로 찍고, 실패가 있으면 1로 끝납니다.
