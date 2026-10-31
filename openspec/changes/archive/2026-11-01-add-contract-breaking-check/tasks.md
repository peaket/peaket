# Tasks

## 1. 공용 태그 규칙

- [x] 1.1 `tools/ci/release-tags.mjs`(태그 규칙·정렬)를 만들고 `release-plan.mjs`가 쓰게 한다. 확인: `node --test tools/ci/release-plan.test.mjs` 회귀 없음.

## 2. 깨짐 검사 스크립트(결정 2~6)

- [x] 2.1 `tools/ci/contract-breaking.test.mjs`를 먼저 쓴다(결정 8). 확인: 스크립트가 없어 실패한다.
- [x] 2.2 `tools/ci/contract-breaking.mjs`와 `docs/api/breaking/`의 수준·예외 파일을 만든다. 확인: 같은 시험이 통과한다.
- [x] 2.3 실제 이미지로 돌린다: 지금 계약(통과), 응답 칸 하나를 지운 사본(OpenAPI 실패), 메시지 칸·열거 기호를 지운 사본(AsyncAPI 본문 실패), 채널을 지운 사본(asyncapi diff 실패), 예외 파일에 이유를 단 줄(통과). 확인: 확인 기록에 적는다.

## 3. CI

- [x] 3.1 `.github/workflows/contract-check.yml`과 `ci.yml`(범위 출력·잡·`ci-summary`)을 고친다(결정 7). 확인: `node tools/ci/check-workflows.mjs` 통과, `node --test tools/ci/*.test.mjs` 회귀 없음.
- [x] 3.2 `tools/ci/README.md`, docs/devops.md §3.1(`contract-check.yml` 행·'지금 있는 것'), docs/api/guidelines.md §1(도구 실행과 AsyncAPI 본문 판정), wbs 0.2.1(md·csv)을 고친다. 확인: 문서 점검 오류 0.

## 3b. 코드 리뷰 반영

- [x] 3b.1 재현 시험을 먼저 써서 실패(6건, 범위 1건)를 보고 고친다: `#` 줄로 라벨·이유 검사를 비켜 감(도구에는 읽은 예외 문장만 넘김), 수준 파일 낮추기에 라벨 요구, 덮어쓰기 값 넓히기도 예외가 는 것, 대상 가지는 갈라진 점과 견줌, 메시지 본문을 JSON·Avro로 나눠 견줌(JSON은 열거 더하기도 ERR), 서비스와 깨짐 검사 도구가 바뀌면 `contracts` 범위. 응답 스키마 자체가 열거인 경우의 값 지우기를 ERR로 올린다. 확인: `contract-breaking.test.mjs` 18/18, `changes.test.mjs` 13/13, `asyncapi-messages.test.ts` 3/3, 실제 이미지로 `#` 줄 우회가 실패하고 Avro 열거 더하기는 WARN·JSON 열거 더하기는 실패.

## 4. 통합 확인

- [x] 4.1 `node --test tools/ci/*.test.mjs`, 저장소 규칙 검사 셋, `pnpm test`, 깨짐 검사를 이 저장소에서 한 번(`--target HEAD --pull-request --labels '["breaking-approved"]'`), 문서 점검, OpenSpec 검증, 줄바꿈 LF. 확인: 모두 통과한다.

## 확인 기록

- 2026-11-01 도구 확인(공식 이미지, 다이제스트 고정, `--network none`): oasdiff 1.34.1은 선택 응답 칸 지우기를 INFO로 둬 그대로는 막지 못했고, 수준 파일로 ERR로 올리자 막았다. 수준 파일은 주석을 받지 않아(종료 코드 106) 스크립트가 주석을 지운 사본을 넘긴다. AsyncAPI CLI 6.2.2의 diff는 3.0 메시지 본문의 칸·열거 기호 지우기를 unclassified로 두고, 작업·채널 지우기와 주소·방향 바꾸기만 breaking으로 잡았다. 실행 기록 전송은 네트워크를 끊자 건너뛰었다.
- 시험을 먼저 쓰고 본 실패: `contract-breaking.test.mjs`(모듈 없음) → 구현 뒤 13/13. 수준 파일 주석 지우기(1건 실패) → 고친 뒤 통과. 라벨을 사건 파일에서 읽기(1건 실패) → 고친 뒤 14/14. `asyncapi-messages.test.ts`(모듈 없음) → 2/2.
- 실제 이미지로 이 저장소에서(임시 작업 트리, 기준 HEAD): 지금 계약 통과. 로비 입장 응답의 `lobbyToken`을 지운 사본은 OpenAPI가 `response-optional-property-removed`로 실패. 그 줄을 예외 파일에 이유와 함께 넣으면 라벨 없이는 'breaking-approved 라벨이 없다'로 실패, `--labels '["breaking-approved"]'`로는 통과. `OrderEvent`의 `seatIds`와 열거 기호 `AUTO`를 지운 사본은 메시지 본문이 ERR 2건으로 실패(asyncapi diff는 통과). 작업 `publishOrderEvent`를 지운 사본은 asyncapi diff가 실패.
- 워크플로 규칙 검사가 라벨 이름을 식으로 넘기는 것을 막아(사용자가 고칠 수 있는 값), 스크립트가 `GITHUB_EVENT_PATH`에서 읽게 바꿨다. `node tools/ci/check-workflows.mjs` 통과(워크플로 8개), `node --test tools/ci/*.test.mjs` 116/116, release-plan 시험 25/25(공용 태그 모듈로 옮긴 뒤 회귀 없음).

- 마지막 확인(2026-11-01): `node --test tools/ci/*.test.mjs` 121/121, `check-workflows`(8개)·CODEOWNERS·`workspace:` 통과, `pnpm test --force` 6묶음(계약 33) 통과, 계약 타입 검사 오류 0, `gen:check` 같음, 문서 점검 오류 0·경고 0, OpenSpec 검증 통과, 새 파일 줄바꿈 LF. 실제 도구로 이 저장소(`--target HEAD --pull-request --labels '["breaking-approved"]'`) 통과. 라벨 없이는 Avro 수준 파일의 WARN 한 줄(처음 넣는 낮춤) 때문에 실패하는 것이 설계대로다.
- 코드 리뷰(새 맥락): 1차 결함 7건과 작은 빈틈 하나·문서 어긋남을 모두 고쳤고(작업 3b), 다시 본 결과 새 결함이 없었다.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다.
- 보관: `pnpm exec openspec archive add-contract-breaking-check --yes`, 그리고 `develop`에 커밋.
- 원격이 생긴 뒤: D-T48을 실제 PR로 돌리고, WARN을 PR 댓글로 다는 단계를 더한다.
