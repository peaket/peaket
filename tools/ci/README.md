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
| `check-workflows.mjs` | 워크플로 규칙: 액션 SHA 고정, `pull_request_target` 금지, 맨 위 `permissions:`, 사용자 입력을 식에 쓰지 않기, 체크아웃의 `persist-credentials: false`, 잡마다 `timeout-minutes`(§4.5). `build-image.yml`의 빌드 잡은 잡 권한이 `contents: read`뿐이고 레지스트리 로그인·푸시·서명·출처 증명 단계가 없어야 합니다(D-T32 ①). GitHub 소유(`actions/`·`github/`)가 아닌 액션은 조직 허용 목록 `infra/stacks/global/github/variables.tf`의 `actions_patterns_allowed` 기본값의 꼴에 맞아야 하고, 그 목록을 읽지 못하면 실패합니다(D-T12 ①, `--allowlist`로 다른 파일을 줄 수 있습니다). 같은 저장소의 재사용 워크플로를 부르는 잡은 부른 워크플로의 모든 잡 권한이 부르는 잡이 준 권한 안이어야 합니다(규칙 10, 적지 않은 것은 none, none < read < write. 넘으면 GitHub이 실행을 시작하지 않습니다) | `tools-check.yml` |
| `image-build.mjs` | 이미지 빌드 잡의 본체(§3.1 `build-image.yml` ①). 플랫폼 하나를 BuildKit(`docker-container` 빌더, 이미지 다이제스트 고정)으로 빌드해 OCI 묶음과 다이제스트를 만들고(`--provenance=false --sbom=false`, 푸시 없음), 같은 이미지를 실어 네트워크 없이 스모크합니다 | `build-image.yml` |
| `image-smoke.mjs` | 이미지 안에서 그 이미지의 node로 돕니다. 이미지 사용자로는 플랫폼·아키텍처가 맞는지와 네이티브 모듈(`.node`)이 모두 열리는지(arm64 러너 스모크), 루트로 따로(`--scm`) 이미지 안 전체에 소스 관리 메타데이터(`.git`·`.svn`·`.hg`·`.bzr`·`CVS`)가 없는지 봅니다(ASVS 13.4.1, 맨 위 `/proc`·`/sys`·`/dev`는 보지 않고 심볼릭 링크는 따라가지 않습니다, ADR-0263 결정 9·13) | `image-build.mjs` |
| `verify-native-binding.mjs` | 미리 빌드한 Kafka 바인딩 대조(§4.4, ADR-0176 결정 5). 설치가 끝난 파일 묶음에서 그 패키지를 찾아 고정 표의 다이제스트로 다시 받은 묶음을 견주고, 묶음과 설치된 `build/` 파일이 같은지 봅니다. 판을 올리면 고정 표부터 고칩니다 | 이미지 Dockerfile의 빌드 단계 |
| `check-codeowners.mjs` | `.github/CODEOWNERS`의 팀이 `teams.json`에 있는지, 첫 줄이 `*`인지, 같은 경로가 두 번 없는지 봅니다(§2.3) | `tools-check.yml` |
| `check-workspace-protocol.mjs` | `@peaket/*`을 `workspace:` 밖의 판으로 적은 곳을 막습니다(§4.4) | `tools-check.yml` |
| `asvs-report.mjs` | ASVS 추적 시험 태그 수집 리포트(docs/architecture.md §8.2 4번, BUILD_ORDER BOT-160). 시험 이름의 `[ASVS v5.0.0-x.y.z]` 태그(대괄호 없는 꼴도 읽되 '꼴이 다른 태그'로 알린다)를 시험 보고서(vitest JSON, JUnit XML)와 원본(`--scan` 폴더의 `*.test.*`·`*.spec.*`·`*-cases.*`. `tools/ci` 아래에서 첫 줄이 `// asvs-report: ignore`인 파일(도구 자신의 시험 자료)은 건너뛴다)에서 모아 ASVS 추적 표(docs/security/asvs/*.md)의 적용·부분 적용 행마다 통과·실패·미실행(원본에 태그가 있으나 이번 보고서에 없음)·태그 없음(태그 시험이 없음)·설계 검사(구현 위치 칸에 `(운영 설계만)`이 있는 행: 통과로 세지 않는다, §8.2 4번)를 내고, 문서마다 요약 표와 실패한 태그 시험, 표에 없는 ID의 태그를 markdown(`--summary`, GitHub 작업 요약에 덧붙인다)과 JSON(`--json`)으로 낸다. 표의 '테스트 결과' 칸은 고치지 않는다. 실패한 태그 시험이 있으면 종료 코드 1, `--strict`면 표에 없는 ID의 태그도 1이다. 뿌리 `pnpm asvs:report`는 `services`·`packages`·`apps`·`tools`·`loadtest`를 훑는다. CI는 ci-node 끝에서 시험 보고서를 모아 작업 요약에 쓴다(BOT-162: vitest는 `packages/config/vitest/report.mjs`가 `PEAKET_TEST_REPORT`로, `node --test`는 `NODE_OPTIONS`의 JUnit 리포터로 보고서를 남긴다) | 단계를 끝낼 때, 보안 판정 검토 때 |
| `test-reports.mjs` | 시험 보고서 읽기(vitest JSON, JUnit XML). `trace-check.mjs`·`asvs-report.mjs`가 같이 쓴다 | — |
| `trace-check.mjs` | 정본 ID 대조(docs/architecture.md §8.6의 5단계, ADR-0178). 범위 목록의 시험 ID마다 이름에 그 ID를 단 시험이 통과했는지 시험 보고서(vitest JSON, JUnit XML)로 봅니다. `X-T12`·`FR-073` 꼴은 가운데 `-`를 빼고 적은 이름(`FR073_…`)도 맞고, `S-T2`는 `S-T27`에 걸리지 않습니다. 통과한 시험이 없는 ID가 있으면 종료 코드 1입니다. ID는 시험 이름 자체에 답니다(`node --test`의 JUnit 보고서는 `describe` 이름을 싣지 않습니다). 같은 ID에 통과와 실패가 섞이면 통과로 세므로, 시험 실행 자체가 통과했는지는 따로 봅니다 | 단계를 끝낼 때(docs/PROGRESS.md 턴 규칙) |
| `records.mjs` | 공용 기록 표 맞추기(ADR-0190 결정 3). 커밋 본문의 정합 점검 행(`정합 점검:`으로 시작하는 R 행)과 BUILD_ORDER 체크로 docs/review/consistency-review.md R 표, docs/00-summary.md §4, docs/wbs/wbs.md·wbs.csv 상태 칸을 맞춥니다. `--check`는 고칠 것이 있으면 1, 읽기·실행 오류는 2, `--next-r`는 다른 갈래의 작업 가지까지 본 다음 R 번호. 지난 커밋의 잘못된 행과 겹친 번호는 경고하고 건너뜁니다. 갈래 1(루프)만 돌립니다 | 루프 턴(손으로) |
| `ledger.mjs` | 완성 장부(ADR-0256 결정 2, docs/architecture.md §8.6). 정본의 시험 시나리오 표 판정 기준을 ①②③ 단위로 나눈 항목, 시나리오가 가리키지 않는 FR·NFR·POL, ASVS 추적 표의 행마다 상태 하나(자동 시험·ID만·측정·사람 확인·미검증·다른 단계·없앰·해당 없음·빈칸)와 등급(A·B·C)을 정해 `docs/review/ledger/`에 씁니다. 자동 시험은 시험 이름에 ID와 바로 뒤 세부 번호(`S-T23 ①`)가 함께 있는 것이고, 손으로 정하는 상태·등급은 `docs/review/ledger-notes.md`에서 읽습니다. `--check`는 고칠 것이 있으면 1, `--scope`·`--batch <묶음> --require`는 범위에 빈칸이나 ID만이 있으면 1, notes·범위·인자 오류는 2. 시험 통과 여부는 보지 않습니다(`trace-check.mjs` 몫). 첫 줄이 `// asvs-report: ignore`인 `tools/ci` 아래 파일은 건너뜁니다 | 묶음을 끝낼 때(`--batch <묶음> --require`), 장부를 고칠 때 |
| `brief.mjs` | 묶음 지시서(ADR-0256 결정 9, docs/architecture.md §8.6 묶음 절차 1). `--batch <묶음>`이면 묶음 표 행, 단계 줄 원문, 장부 범위의 판정 항목, 묶음 ID가 나오는 정본 자리(문서:줄과 가까운 제목), 코드 자리, 닿을 CI 잡, 자주 놓친 결함, 읽기 규칙을 한 장(6만 자 안)으로 뽑는다. 정본에서 그때마다 뽑으므로 사본이 아니다. `--out <파일>`로 저장소 밖에 쓰고 담당에게 그 경로를 준다. 끝 코드 0·2 |
| `vuln-deadline.mjs` | 취약점 조치 기한과 예외 만료 판정(docs/devops.md §4.4 '조치 기한 판정', BUILD_ORDER BAS-010 ①, ADR-0259 결정 10). pnpm 내장 의존성 검사(`pnpm audit --json`)·라이선스 검사(`pnpm licenses list --json`) 결과와 예외 파일 `vuln-exceptions.json`을 읽어, 유효한 예외가 없는 치명·높음이면 실패하고 중간 이하는 알림만 남깁니다. 검사 결과를 읽지 못하거나 형식이 틀리면 막고, pnpm `auditConfig`의 무시 설정이 있어도 막습니다 | `security-scan.yml` |
| `scan-tools.mjs` | 외부 보안 검사 도구의 고정 표(gitleaks 판·주소·SHA-256, Trivy 이미지 다이제스트)와 실행(docs/devops.md §4.4 '외부 보안 검사 게이트', ADR-0263 결정 1·2·7). `fetch-gitleaks`는 GitHub 릴리스 묶음을 받아 SHA-256이 맞을 때만 실행 파일 하나를 꺼내고(받아 둔 묶음도 다시 잽니다), `gitleaks`는 설정(`gitleaks.toml`)·무시 목록(`gitleaks-ignore`)의 꼴(허용 블록의 `targetRules`, `^…$`로 묶은 좁은 값 꼴, 8자 이상 `stopwords`)을 본 뒤 실행 때 만든 미끼 비밀을 먼저 찾게 하고 못 찾으면 이력을 보지 않고 끝내며, 찾으면 지금 커밋에서 닿는 전체 이력(`--all-refs`면 모든 가지·태그)을 병합 커밋의 차이(`-m`)까지 가려(`--redact`) SARIF로 냅니다. `trivy-config`·`trivy-image`는 다이제스트 고정 Trivy(GHCR)를 `docker run --network none`으로 띄워 IaC 설정 검사·이미지 비밀 검사만 합니다(검사 규칙·취약점 자료를 받지 않습니다). 두 검사 모두 실행 때 만든 미끼(높음이 나와야 할 Dockerfile·Terraform·값 파일로만 그려지는 작은 차트, 내장 허용 경로 아래 것까지 가짜 비밀을 담은 작은 이미지 묶음)를 같은 인자로 먼저 돌려 못 찾으면 대상을 보지 않고 끝내고, 설정 검사는 대상 안의 줄 안 무시 주석(`trivy:ignore`·`tfsec:ignore`)을 막으며 공용 차트를 CI 값 파일(`trivy-chart-values.yaml`)로도 그립니다. 판정은 하지 않습니다 | `security-scan.yml`(`secrets`·`iac-config`), `build-image.yml`(`build`) |
| `scan-gate.mjs` | 외부 보안 검사 판정(ADR-0263 결정 4·5, ASVS 13.3.1·15.3.6·16.5.3). gitleaks·CodeQL·Trivy의 SARIF를 읽어 비밀은 하나라도, CodeQL·Trivy 설정 검사는 보안 등급 7.0 이상과 CodeQL 프로토타입 오염 쿼리 셋을 막고 나머지는 알림만 남깁니다. 그 쿼리 셋이 돈 흔적이 없거나, 결과 파일이 없거나 틀리거나, gitleaks가 누출 아닌 까닭으로 끝나면 막습니다. 예외는 `scan-exceptions.json`(도구·규칙·경로·사유·이슈·맞을 결과 수 `count`·만든 날·만료일, 만료 30일 [가정])뿐이고 비밀 검사 결과는 예외로 풀지 않습니다. 설계로 받아들인 결과(IaC 설정 검사만)는 같은 파일에 이슈 대신 근거 ADR(`adr`, `docs/adr`의 그 파일 본문에 그 규칙 ID가 있어야 합니다)과 다시 볼 날(`reviewOn`, 1년 [가정] 안)을 적은 줄로 두고, 알림 줄에 '받아들인 결과 ADR-…(다시 볼 날 …)'로 남깁니다(ADR-0263 결정 12·13). 한 줄에 `count`보다 많은 결과가 맞으면 막고, 쓰이지 않는 줄은 푸시·예약 실행에서 막고 PR(`--event pull_request`)에서는 알림만 남깁니다. 보고서·잡 요약에는 규칙·파일·줄(·커밋)만 적습니다 | `security-scan.yml`, `build-image.yml` |
| `check-repo-visibility.mjs` | 봇 저장소 `peaket-bots`가 `infra/stacks/global/github/repositories.tf`에서 글자 그대로 `visibility = "private"`인지 봅니다(POL-026, ADR-0263 결정 13). 저장소 리소스의 visibility가 맵 값(each.value.visibility)을 그대로 쓰는지도 봅니다. 공개 모노레포(GIT-0001)를 받아들인 결과로 두는 대신 따로 막습니다 | `security-scan.yml`(`iac-config`) |
| `entry.mjs` | 판정 도구의 직접 실행 판별(실제 경로로 견줌). 이름은 같은데 경로가 맞지 않으면 통과가 아니라 실패로 끝냅니다(ADR-0263 결정 13 ⑦) | `scan-gate.mjs`·`scan-tools.mjs`·`vuln-deadline.mjs`·`check-repo-visibility.mjs` |
| `check-lint-disables.mjs` | 보안 린트 규칙(`peaket-web/*`·`peaket-service/*`)이나 모든 규칙을 끄는 `eslint-disable` 주석을 찾아 거절합니다. 이름을 단 예외는 `lint-disable-exceptions.json`(파일·까닭)에만 둡니다(디자인 캔버스 보드 파일 54곳). docs/devops.md §4.4, BUILD_ORDER BAS-010 ①, ADR-0259 결정 12 | `ci.yml`의 `lint-guard` |
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

외부 보안 검사 판정은 결과 파일만 있으면 로컬에서도 돕니다(gitleaks·CodeQL은 이 PC에서 돌리지 않고 CI가 냅니다, ADR-0263 결정 11).

```bash
node tools/ci/scan-tools.mjs trivy-config --out out/trivy-config
node tools/ci/scan-gate.mjs --tool trivy-config --sarif out/trivy-config
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
