# Tasks

## 1. 재현 시험과 공용 제목 규칙

- [x] 1.1 `branch-policy.test.mjs`에 재현 시험을 먼저 더한다: 워크플로와 다른 경로가 함께 바뀐 `release/*`·`hotfix/*`·`merge/*` PR은 통과하고, 같은 내용의 `feature/*` PR은 그대로 실패한다(design.md 결정 9). 확인: 고치기 전에 새 시험이 실패한다.
- [x] 1.2 `tools/ci/conventional.mjs`를 만들고 `branch-policy.mjs`가 그것을 쓰게 바꾸며, 분리 검사를 변경을 만드는 PR에만 건다(결정 3·9). 확인: `node --test "tools/ci/*.test.mjs"`가 모두 통과한다(D-T41 회귀 없음).

## 2. 릴리스 계획 스크립트

- [x] 2.1 `tools/ci/release-plan.test.mjs`를 먼저 쓴다(결정 2·4~8). 경우: 첫 판 0.1.0, D-T41 ④(0.y.z에서 호환을 깨는 변경은 y를 올림), `feat`→MINOR·`fix`→PATCH, 1.0.0 뒤 호환을 깨는 변경은 MAJOR, 역병합으로 들어온 릴리스 커밋은 세지 않음, 출시할 변경 없음, 열린 릴리스 가지가 있으면 열지 않음, 핫픽스 판(마지막 태그 Z+1)과 열린 핫픽스가 있으면 실패, 버전을 올린 `package.json`, 변경 기록의 범위 묶음과 `@이름` 감싸기, 바뀐 배포 단위, `finish`의 이름 검사·이미 있는 태그·작은 판, D-T23(릴리스의 역병합 대상 `develop`), D-T25(열린 릴리스가 있는 핫픽스의 대상), `verify`의 두 번째 부모·트리 확인. 확인: 스크립트를 만들기 전에 시험이 실패한다.
- [x] 2.2 `tools/ci/release-plan.mjs`를 만든다. 확인: 같은 시험이 통과한다.

## 3. 워크플로

- [x] 3.1 `.github/workflows/release.yml`(잡 `start`, `finish`)을 만든다(결정 1·8·10·11). 액션은 design.md의 커밋 SHA로 고정한다. 확인: `node tools/ci/check-workflows.mjs`가 통과하고 YAML로 읽힌다.
- [x] 3.2 `tools/ci/README.md`에 새 스크립트와 실행법을 적는다. 확인: 적은 명령이 그대로 돈다.
- [x] 3.3 (구현 중 찾음) `check-workflows.test.mjs`에 `github.event_name`을 허용하는 재현 시험을 먼저 더해 실패를 보고, `check-workflows.mjs`를 고친다(결정 12). 확인: 같은 시험과 `node tools/ci/check-workflows.mjs`가 통과한다.

## 4. 정본 반영과 통합 확인

- [x] 4.1 정본에 반영한다: devops §2.2.1(역병합 가지), §2.2.2 1번(첫 커밋), §2.2.6(분리 검사 대상), §3.1(`release.yml` 행과 '지금 있는 것'), wbs 0.1.2(CSV 포함). 확인: 문서 점검 오류 0이다.
- [x] 4.2 전체를 한 번에 확인한다: `node --test "tools/ci/*.test.mjs"`, 저장소에서 `check-workflows`·CODEOWNERS·`workspace:` 검사, `release-plan.mjs start --kind release`를 이 저장소에서 한 번 돌림, 문서 점검, OpenSpec 검증, 새 파일의 줄바꿈 LF. 확인: 모두 통과한다.

## 5. 코드 리뷰 반영(design.md 결정 13)

- [x] 5.1 `branch-policy.test.mjs`에 재현 시험을 먼저 더한다: 포크에서 온 출시 가지 이름 PR, 보호 가지에 없는 섞인 커밋의 `merge/*` PR, 역병합 가지에 사람이 얹은 섞인 커밋은 실패하고, 봇의 판 맞춤 커밋은 통과한다. 고친 뒤 통과한다. 확인: 고치기 전 3개 실패, 고친 뒤 21개 통과.
- [x] 5.2 `release-plan.test.mjs`에 재현 시험을 먼저 더한다: 열린 핫픽스가 있을 때 릴리스 판, 판이 겹치는 핫픽스 거부, `--merged`로 이어 가기(태그 있음·없음), 태그가 다른 커밋에 있거나 병합 커밋이 아님, 핫픽스 역병합의 판 맞춤. 고친 뒤 통과한다. 확인: 고치기 전 5개 실패, 고친 뒤 전체 102개 통과.
- [x] 5.3 `release.yml`: 앱 토큰에 workflows 권한, `finish`를 병합된 PR에서 이어 가게, 이미 한 단계는 건너뛰게, 역병합 가지에 판 맞춤 커밋. 정본(devops §2.2.6·§3.1, secrets-and-keys '릴리스 봇' 행)에 반영한다. 확인: `node tools/ci/check-workflows.mjs` 통과, YAML 읽힘, 문서 점검 오류 0.

## Workflow follow-up

- 대조: OpenSpec 대조(verify 스킬).
- 브라우저 확인: 해당 없음(화면이 없다).
- 코드 리뷰: 새 맥락의 리뷰 에이전트, 나온 것은 이 사이클에서 고친다(사이클 단위로 맡기기, architecture §8.6). 2026-10-31에 4건(높음 1, 중간 2, 낮음 1)이 나왔고 모두 재현 시험을 먼저 만들어 고쳤다(작업 5).
- 보관: `pnpm exec openspec archive add-release-workflows --yes`, 그리고 `develop`에 커밋.
- 원격과 릴리스 봇 앱을 만든 뒤: 첫 릴리스에서 D-T23·D-T24·D-T25를 실제로 돌려 본다.
