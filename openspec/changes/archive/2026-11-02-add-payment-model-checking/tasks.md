# Tasks

## 1. 검사 실행기의 진행성 검사(시험부터)

- [x] 1.1 실패하는 시험 쓰기: `tools/spec-check/spec-check.test.mjs`에 목록의 `temporal`(명세 파일에 있는 이름만, 검사는 그 가운데 하나, `tlc: false`·`invariant(s)`·`samples`와 함께 거절), TLC 출력의 진행성 위반 읽기와 반례 경로 자르기, 진행성 검사의 판정과 결과 기록. 확인: 고치기 전 실패(내보내지 않은 `runsInSimulation`을 빈 함수로 두고 돌려 새 시험 6개 실패를 보았다).
- [x] 1.2 `spec-check.mjs`의 목록 검사·TLC 출력 읽기·판정·기록·실행(`--temporal`, PR에서 건너뜀)을 고친다. 확인: `node --test tools/spec-check/spec-check.test.mjs tools/spec-check/fetch-tools.test.mjs` 통과.
- [x] 1.3 (이 사이클에서 더함) 반례 경로가 길어 PR 시뮬레이션이 닿지 않는 변형을 전수 검사에서만 보는 `simulate: false`. 이중 결제 변형의 반례가 14걸음이라 시뮬레이션 10만 회로도 찾지 못해 더했다. 시험부터 썼다(실패 1개 확인 뒤 구현).
- [x] 1.4 (리뷰 뒤) TLC 진행 줄(Progress)의 쉼표 숫자가 아니라 맨 끝 요약 줄에서 상태 수를 읽기, 불변식 전수 지켜짐 검사가 하나는 있어야 함(진행성 검사는 세지 않음), 진행성 검사에 `simulate` 거절. 재현 시험을 먼저 써 실패를 보고 고쳤다. 확인: 도구 시험 44개 가운데 43개 통과(1개는 이 PC에 Quint를 설치하지 않아 원래부터 건너뜀).

## 2. 결제 명세

- [x] 2.1 검사 목록 `specs/specs.json`에 `payment`를 쓴다(지켜질 모듈, 진행성 모듈, 반례가 나와야 할 변형, V-T1). 확인: 목록 검사가 명세 파일의 모듈·불변식·진행성 이름과 맞는지 본다. 순서는 계획과 달리 명세(2.2)의 첫 판을 먼저 쓰고 모듈을 시뮬레이션으로 확인한 뒤 목록을 썼다.
- [x] 2.2 `specs/payment.qnt`(docs/verification.md §2.1 `payment`의 동작, 불변식 ①~④와 정본이 적은 ⑤⑥, 진행성, 검사 모듈). 확인: `node tools/spec-check/run-local.mjs pr --spec payment`에서 지켜질 모듈 셋은 위반 없음, 정본 모듈과 변형 다섯은 노린 불변식의 반례(진행성 셋과 `simulate: false` 하나는 건너뜀).
- [x] 2.3 전수 검사 범위를 시간으로 정한다. 처음 판은 정본 범위 그대로 끝났지만(상태 300만 개), 리뷰 뒤 발권·보상을 걸음으로 나눈 모형은 주문 1건 결제 시도 2번이 상태 30,364개, 주문 2건 결제 시도 1번씩이 6,115,232개라 전수 검사를 이 두 범위로 나누고 정본 범위 전체는 시뮬레이션으로 둔다. 진행성은 주문 1건 결제 시도 2번. 확인: `run-local.mjs full --spec payment --write`가 13검사 모두 통과하고 `specs/results/payment.json`과 반례 경로가 남는다.

## 3. 정본 반영과 확인

- [x] 3.1 정본: docs/verification.md §2.1·§2.2·§2.3·§2.6·V-T1, docs/features/payment.md §3·§11, ADR-0015·0044·0057·0106 상태 줄, specs/README.md, tools/spec-check/README.md, wbs 0.9.3, BUILD_ORDER 넘김, PROGRESS OPEN[17], 00-summary·consistency-review R-231(R-230 숫자 바로잡음). 확인: `python -I tools/doc-check/check_all.py` 오류 0.
- [x] 3.2 전체 확인: 도구 시험, CI 도구 시험, 워크플로 규칙, 문서 점검, `openspec validate --all`, 세 명세의 PR 검사(대기열·좌석은 회귀). 확인: 모두 통과.

## Workflow follow-up

- 탐색: 정본의 결제 동작(payment §2~§5·§8, transfer-refund §5, ADR-0015·0044·0106·0107·0140, ticket.proto)과 FND-130·FND-140 도구를 읽었다(design.md 맥락). Quint의 TLC 연결이 공정성 붙은 진행성 속성을 검사하는지 작은 명세로 확인했다.
- 대조: `openspec` 대조(verify 스킬의 단계대로 작업·설계 결정·코드 모양을 봄).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락 리뷰 두 번. 1차 5건(보상·발권을 한 걸음으로 묶어 추천안의 순서 틈을 가림 높음, 승인 기한 가정이 정본보다 강함 중간, 공정성이 발권 성공을 가정해 보상 경로를 보지 않음 중간, TLC 진행 줄의 상태 수를 읽음 낮음, ④의 범위 낮음)을 모두 고쳤다(발권·보상을 걸음으로 나눔, ⑥과 조건부 갱신·CS 경로 변형, 기한 전 요청은 기한 뒤에도 승인 가능, 상태 수는 요약 줄에서, ④ 범위 적음). 2차는 다섯 고침을 확인하고 4건을 더 찾았다: 발권 막기가 ticket-svc 장애를 무시해 추천안 진행성이 낙관적(중간, 가정을 명세와 OPEN[17]의 대가로 적음), 접수한 주문이 결국 끝나는지 보지 않음(낮음, 진행성에 더함), ④ 범위와 금액 대조 전제(낮음, 적음), 목록 검사 빈틈 둘(낮음, 시험부터 고침). 세 번째 리뷰는 돌리지 않았다.
- 보관: `openspec archive add-payment-model-checking --yes`, 그리고 `develop`에 커밋.
