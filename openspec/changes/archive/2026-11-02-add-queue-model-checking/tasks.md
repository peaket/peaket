# Tasks

## 1. 도구 받기(시험부터)

- [x] 1.1 실패하는 시험 쓰기: `tools/spec-check/fetch-tools.test.mjs`(고정표의 https 주소·SHA-256·판 번호, 설치한 Quint가 찾는 판과 같음, 해시가 다르면 풀지 않음, 받아 둔 것이 바뀌면 다시 받음, https 아니면 거절). 확인: 빈 모듈에서 6개 실패.
- [x] 1.2 `fetch-tools.mjs` 구현(Apalache 0.62.4 묶음, Quint 평가기 v0.7.1, 압축 파일은 릴리스 자산 다이제스트, 푼 것은 SHA-256: Apalache는 폴더 전체, 평가기는 실행 파일. 바뀌거나 없어진 파일이 있으면 다시 받음). 확인: `node --test "tools/spec-check/*.test.mjs"` 통과, 실제로 받은 묶음의 해시가 GitHub 다이제스트와 같다.
- [x] 1.3 따로 작업 공간(`package.json`·`pnpm-workspace.yaml`·`pnpm-lock.yaml`, Quint 0.33.1, 쓰지 않는 `@octokit/request` 뺌)과 로컬 이미지(`Dockerfile`, `run-local.mjs`). 확인: 컨테이너 안 pnpm 12.16.0으로 잠금 파일을 만들고 `--frozen-lockfile` 설치가 되며, 이미지 안에서 `java -version`과 `quint typecheck`가 돈다.

## 2. 검사 실행기(시험부터)

- [x] 2.1 실패하는 시험 쓰기: `tools/spec-check/spec-check.test.mjs`(목록 검사, TLC·시뮬레이션 출력 읽기, 지켜짐·반례 판정, 결과 파일 칸, 한국 시각, 시뮬레이션만 하는 검사). 확인: 빈 모듈에서 실패.
- [x] 2.2 `spec-check.mjs` 구현(`typecheck`·`pr`·`full --write`). 확인: 같은 시험 통과.

## 3. 대기열·입장 제어 명세

- [x] 3.1 검사 목록 `specs/specs.json`을 먼저 쓴다(지켜질 모듈과 반례가 나와야 할 변형, V-T1). 확인: 명세가 없으면 목록 검사가 실패한다.
- [x] 3.2 `specs/queue.qnt`(docs/verification.md §2.1 `queue`의 동작과 불변식 ①~④, 1인 1순번 ⑤, 검사 모듈). 확인: `node tools/spec-check/run-local.mjs pr`에서 지켜질 모듈 셋은 위반 없음, 정본 모듈 둘과 변형 셋은 노린 불변식의 반례.
- [x] 3.3 전수 검사 범위를 시간으로 정한다(정본 범위의 TLC가 끝나지 않으면 범위를 나누고 기록). 확인: `run-local.mjs full --write`가 통과하고 `specs/results/queue.json`과 반례 경로(TLC `.tlc.txt`, 시뮬레이션 동작 기록 `.itf.json`)가 남는다.

## 4. CI

- [x] 4.1 실패하는 시험 쓰기: `tools/ci/changes.test.mjs`에 `specs`·`specs_full` 범위. 확인: 2개 실패.
- [x] 4.2 `tools/ci/changes.mjs`, `.github/workflows/spec-check.yml`, `ci.yml`의 `spec-check` 잡과 `ci-summary`. 확인: `node --test "tools/ci/*.test.mjs"` 통과, `node tools/ci/check-workflows.mjs` 통과.

## 5. 정본 반영과 확인

- [x] 5.1 정본: docs/verification.md §2.1·§2.2·§2.6·V-T1, docs/devops.md §3.1, docs/architecture.md §9.4, docs/features/queue-admission.md §3, docs/security/asvs/delivery.md 15.2.4, ADR-0002·0041·0056·0057 상태 줄, wbs 0.9.1, PROGRESS OPEN[13]·OPEN[14], BUILD_ORDER 넘김. 확인: `python -I tools/doc-check/check_all.py` 오류 0.
- [x] 5.2 전체 확인: 도구 시험, CI 도구 시험, 워크플로 규칙, 문서 점검, `openspec validate --all`. 확인: 모두 통과.

## Workflow follow-up

- 탐색: Quint 0.33.1 `dist`를 읽어 TLC를 띄우는 길과 도구를 받는 길을 봤다(design.md 맥락).
- 대조: `openspec` 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락 리뷰 세 번(5건·5건·5건), 모두 이 사이클에서 고쳤다. 정본 틈 둘은 PROGRESS OPEN[13]·OPEN[14]로 물었다.
- 보관: `openspec archive add-queue-model-checking --yes`, 그리고 `develop`에 커밋.
- 원격을 만든 뒤: 첫 PR에서 `spec-check` 잡을 실제로 돌려 본다(러너의 TLC 시간).
