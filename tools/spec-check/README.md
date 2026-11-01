# tools/spec-check — 규칙 모델 검사 도구

`specs/`의 Quint 명세를 형식 검사, 시뮬레이션, TLC 전수 검사로 돌리고 결과를 남깁니다(docs/verification.md §2.2, wbs 0.9.1). 무엇을 검사하는지는 `specs/specs.json`과 `specs/README.md`에 있습니다.

| 파일 | 하는 일 |
| --- | --- |
| `spec-check.mjs` | `typecheck`(형식 검사), `pr`(형식 검사 + 검사마다 시뮬레이션, 고정 시드), `full`(형식 검사 + 검사마다 TLC 전수 검사, `--write`면 `specs/results/`에 결과와 반례 경로). 지켜짐을 기대한 검사는 위반이 없고 TLC가 끝까지 돌아야, 반례를 기대한 변형은 노린 불변식의 반례가 나와야 통과합니다. 진행성 검사(검사 목록의 `temporal`, `quint verify --temporal`)와 `simulate: false`인 검사는 `full`에서만 돌고 `pr`은 건너뛰었다고 찍습니다(wbs 0.9.3) |
| `fetch-tools.mjs` | Apalache 묶음(안에 TLC가 있습니다)과 Quint Rust 평가기를 고정 판·고정 해시로 받아 Quint가 찾는 자리(`QUINT_HOME`, 기본 `~/.quint`)에 둡니다. Quint는 처음 쓸 때 이 둘을 해시 확인 없이 받기 때문에 먼저 채워 둡니다. `spec-check.mjs`도 검사 전에 매번 불러 해시를 다시 봅니다 |
| `run-local.mjs` | 이 PC(Windows)에서 컨테이너(`peaket/spec-check:local`)로 `spec-check.mjs`를 같은 인자로 부릅니다 |
| `Dockerfile` | 로컬 실행 이미지. Temurin 21 JRE + Node 24(서비스 뼈대와 같은 다이제스트) + 잠금 파일대로 설치한 Quint + 고정 해시로 받은 도구 |
| `package.json`·`pnpm-lock.yaml`·`pnpm-workspace.yaml` | 이 도구만의 작업 공간입니다(뿌리 작업 공간에 넣지 않습니다). 보안 설정은 뿌리와 같습니다(docs/devops.md §4.4) |

## 고정한 판(2026-11-02)

| 도구 | 판 | 받는 곳 | 해시 |
| --- | --- | --- | --- |
| Quint | 0.33.1(2026-10-28 게시) | npm `@informalsystems/quint` | 잠금 파일의 무결성 값 |
| Apalache(TLC 포함) | 0.62.4(2026-10-12 게시) | GitHub 릴리스 `apalache-mc/apalache` `apalache.tgz` | 압축 파일은 릴리스 자산 다이제스트, 푼 `apalache/` 폴더는 모든 파일의 경로·해시로 만든 폴더 해시(Quint가 띄우는 `bin/apalache-mc`와 TLC가 든 `lib/apalache.jar` 포함) |
| Quint Rust 평가기 | v0.7.1(2026-10-28 게시) | GitHub 릴리스 `quint-co/quint` `evaluator/v0.7.1` | 압축 파일은 릴리스 자산 다이제스트, 실행 파일은 푼 파일의 SHA-256 |
| Java | Temurin 21 | 로컬: `eclipse-temurin:21-jre-noble` 다이제스트 고정, CI: `actions/setup-java` | — |

- Quint 판을 올리면 그 판의 `dist/src/apalache.js`(`DEFAULT_APALACHE_VERSION_TAG`)와 `dist/src/rust/binaryManager.js`(`QUINT_EVALUATOR_VERSION`)가 찾는 판으로 `fetch-tools.mjs`의 표를 함께 바꿉니다. 시험(`fetch-tools.test.mjs`)이 둘이 같은지 봅니다.
- Quint 0.33.1이 선언만 하고 쓰지 않는 `@octokit/request`는 설치에서 뺐습니다. 그 아래 `@octokit/endpoint` 9.0.6이 신뢰 증거가 약해진 판이라 `trustPolicy: no-downgrade`에 걸리기 때문입니다. 예외를 두지 않고 뺐습니다(추천 적용 2026-11-02).
- 기록 형식(ITF)의 `mbt::` 칸은 Quint가 실험 기능으로 둡니다(docs/verification.md §2.4). 판을 올려 형식이 바뀌면 모델 기반 시험의 재생(wbs 2.3.4)을 멈추고 이름 목록 검사만 남깁니다.

## 돌리기

```bash
node --test "tools/spec-check/*.test.mjs"          # 도구 자체 시험(Quint·Java 없이 돈다)
node tools/spec-check/run-local.mjs pr              # 컨테이너에서 시뮬레이션
node tools/spec-check/run-local.mjs full --write    # 컨테이너에서 TLC 전수 검사와 결과 기록
```

이 PC에서는 pnpm 12 실행 파일이 Windows 응용 프로그램 제어에 막혀 있어(PROGRESS OPEN[12]) 잠금 파일을 컨테이너 안의 pnpm 12.16.0으로 만들었습니다(`pnpm install --lockfile-only`).
