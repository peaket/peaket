# tools/ci — CI가 부르는 점검 스크립트

공용 CI의 판단은 모두 이 폴더의 스크립트가 합니다. 워크플로(`.github/workflows/`)는 이 스크립트를 부르기만 합니다. 그래서 원격 저장소 없이도 로컬에서 같은 판단을 시험할 수 있습니다(docs/devops.md §3.1, openspec 변경 `add-ci-foundation`). 모두 의존성 없는 Node 스크립트이고 Node 24에서 돌립니다.

| 스크립트 | 하는 일 | 부르는 곳 |
| --- | --- | --- |
| `changes.mjs` | 바뀐 파일로 검사 범위(`docs`, `contracts`, `js`, `js_all`, `data`, `infra`, `deploy`, `loadtest`, `tools`, `ci`)를 고릅니다. 비교 기준이 없거나 git이 실패하면 전체를 고릅니다(D-T47) | `ci.yml`의 `changes` |
| `ci-summary.mjs` | 앞선 잡이 하나라도 실패하거나 취소되면 실패합니다. 건너뛴 잡은 실패가 아닙니다 | `ci.yml`의 `ci-summary`(필수 검사) |
| `branch-policy.mjs` | 가지 쌍, PR 제목 형식, 빌드 절차 변경 PR에 다른 경로가 섞였는지를 봅니다. 같은 저장소의 릴리스·핫픽스·역병합 PR은 보호 가지에 아직 없는 새 커밋이 바꾼 파일만 섞임 검사를 합니다(이미 병합된 변경을 옮길 뿐입니다). 포크 PR은 바뀐 파일 전부를 봅니다. 작업 가지가 3일을 넘기면 경고합니다(§2.2.6, D-T41) | `branch-policy.yml`(필수 검사) |
| `conventional.mjs` | Conventional Commits 제목 규칙(허용 종류, 형식, 호환을 깨는 표시). PR 제목 검사와 버전 계산이 함께 씁니다 | `branch-policy.mjs`, `release-plan.mjs` |
| `release-plan.mjs` | 릴리스·핫픽스 계획. `start`는 다음 판(SemVer, 0.y.z 규칙)·변경 기록·바뀐 배포 단위·버전을 올린 `package.json`을, `finish`는 태그·후보·역병합 대상과 `merge/*` 가지 이름을, `verify`는 `main` 병합 커밋의 두 번째 부모와 트리를 봅니다(§2.2.2~§2.2.5, D-T22·D-T23·D-T25·D-T41 ④) | `release.yml` |
| `check-merge-tree.mjs` | 후보를 대상에 병합한 결과 트리가 후보의 트리와 같은지 봅니다(§2.2.4, D-T22) | `merge-tree.yml`(`main` 필수 검사) |
| `check-workflows.mjs` | 워크플로 규칙: 액션 SHA 고정, `pull_request_target` 금지, 맨 위 `permissions:`, 사용자 입력을 식에 쓰지 않기, 체크아웃의 `persist-credentials: false`, 잡마다 `timeout-minutes`(§4.5) | `tools-check.yml` |
| `check-codeowners.mjs` | `.github/CODEOWNERS`의 팀이 `teams.json`에 있는지, 첫 줄이 `*`인지, 같은 경로가 두 번 없는지 봅니다(§2.3) | `tools-check.yml` |
| `check-workspace-protocol.mjs` | `@peaket/*`을 `workspace:` 밖의 판으로 적은 곳을 막습니다(§4.4) | `tools-check.yml` |
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

`branch-policy.mjs`는 GitHub가 주는 PR 사건 파일을 읽습니다. 로컬에서는 같은 모양의 JSON(`pull_request.title`, `body`, `head.ref`, `head.sha`, `base.ref`, `base.sha`)을 만들어 `GITHUB_EVENT_PATH`로 넘깁니다. `ci-summary.mjs`는 잡 결과를 `NEEDS` 환경 변수(JSON)로 받습니다.

- `node --test`에는 폴더가 아니라 따옴표로 감싼 글롭을 줍니다. Node 24는 폴더 이름을 파일로 읽습니다.
- 시험은 운영체제의 임시 폴더에 git 저장소를 만들고, 시험 프로세스가 끝날 때 지웁니다. 시험 시간은 1분 안팎입니다.
