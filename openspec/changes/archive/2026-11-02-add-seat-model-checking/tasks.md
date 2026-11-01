# Tasks

## 1. 검사 실행기(시험부터)

- [x] 1.1 실패하는 시험 쓰기: `tools/spec-check/spec-check.test.mjs`에 명세 이름 겹침(대소문자 무시)·모양 거절, 같은 명세 안 모듈 이름 겹침(대소문자 무시), 검사별 시뮬레이션 횟수 `samples`, 지켜짐 검사의 불변식 고르기 `invariants`. 확인: 고치기 전 실패(이름 2개, `simulationFor`·`invariantsFor` 없음, 대소문자 2개).
- [x] 1.2 `spec-check.mjs`의 `loadManifest`·`simulationFor`·`invariantsFor`와 시뮬레이션·TLC 실행이 검사별 설정을 쓴다. 확인: `node --test tools/spec-check/spec-check.test.mjs tools/spec-check/fetch-tools.test.mjs` 34개 통과(1개 건너뜀).

## 2. 좌석 명세

- [x] 2.1 검사 목록 `specs/specs.json`에 `seat`를 먼저 쓴다(지켜질 모듈과 반례가 나와야 할 변형, V-T1). 확인: 명세 파일이 없으면 목록 검사가 실패한다.
- [x] 2.2 `specs/seat.qnt`(docs/verification.md §2.1 `seat`의 동작과 불변식 ①②③, 펜싱 토큰 ④, 교착 ⑤, 검사 모듈). 확인: `node tools/spec-check/run-local.mjs pr --spec seat`에서 지켜질 모듈 둘은 위반 없음, 정본 모듈 둘과 변형 넷은 노린 불변식의 반례.
- [x] 2.3 전수 검사 범위를 시간으로 정한다(정본 범위의 TLC는 10분에 상태 2,000만 개를 넘어도 끝나지 않아 범위를 줄임). 확인: `run-local.mjs full --spec seat --write`가 통과하고 `specs/results/seat.json`과 반례 경로(`.tlc.txt`·`.itf.json`)가 남는다.

## 3. 정본 반영과 확인

- [x] 3.1 정본: docs/verification.md §2.1·§2.2·§2.6·V-T1, docs/features/seat-hold.md §3·§5·§12, ADR-0014·0057·0121 상태 줄, specs/README.md, wbs 0.9.2, BUILD_ORDER 넘김, PROGRESS OPEN[15]·OPEN[16], 00-summary·consistency-review R-230. 확인: `python -I tools/doc-check/check_all.py` 오류 0.
- [x] 3.2 전체 확인: 도구 시험, CI 도구 시험, 워크플로 규칙, 문서 점검, `openspec validate --all`, 두 명세의 PR 검사(`pr`, 대기열은 회귀). 확인: 모두 통과.

## Workflow follow-up

- 탐색: 정본의 좌석 동작(seat-hold §3~§6·§9, payment §2, data.md §3, ADR-0014·0121)과 FND-130 도구를 읽었다(design.md 맥락).
- 대조: `openspec` 대조(verify 스킬의 단계대로 작업·설계 결정·코드 모양을 봄).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락 리뷰 두 번(4건·2건), 모두 이 사이클에서 고쳤다. 추천안을 다시 만들기 판 번호 방식으로 바꿨고, 정본 틈 둘은 PROGRESS OPEN[15]·OPEN[16]으로 물었다.
- 보관: `openspec archive add-seat-model-checking --yes`, 그리고 `develop`에 커밋.
