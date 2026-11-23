# FIX-roles-tdd 계획 — 역할 확인을 시험 먼저·시험 고정 차례로 바꾼다(ADR-0372)

- 기능 ID: FIX-roles-tdd(기능 표 밖의 고침, 갈래 감독)
- 가지: `feature/coord-FIX-roles-tdd`, 작업 폴더 `D:/ticketpass-coord-tdd`
- 근거: [ADR-0372](../../adr/0372-tdd-frozen-tests-no-post-impl-review.md) 결정 5, [docs/architecture.md](../../architecture.md) §8.6 '역할 나누기'의 구성·차례·계획 파일 줄
- 등급: B(진행 도구). 이 고침 자체도 ADR-0372 차례(계획 → 시험 → 시험 리뷰 → 구현)로 한다.

## 1. 바꿀 파일

- `tools/ci/roles-check.mjs`(구현 담당)
- `tools/ci/roles-check.test.mjs`(시험 담당)
- 공개 인터페이스는 그대로다: `node tools/ci/roles-check.mjs [--base] [--head] [--root]`, 끝 코드 0·1·2, 출력 줄 꼴(`실패: [<검사>] …`, `묶음 <ID>: <종류> 커밋 …`, `통과: …`). 묶음 종류 이름(`코드`·`코드(정방향)`·`시험만`·`문서`·`기록만`)도 그대로다.

## 2. 규칙(ADR-0372 결정 5)

| 번호 | 대상 | 규칙 | 실패 꼴 |
| --- | --- | --- | --- |
| T1 | 시험 먼저 코드 묶음(`Batch-Order` 없음, 구현 있음) | 구성: plan·test·review·impl이 하나 이상씩. verify는 없어도 된다 | `[구성] 코드 묶음에 <빠진 역할> 커밋이 없다` |
| T2 | 시험 먼저 코드 묶음 | 차례: 처음 나온 커밋끼리 plan < test < review < impl. verify가 있으면 plan·test·impl 뒤(지금과 같음) | `[차례] 첫 <r> 커밋이 첫 <q> 커밋보다 먼저 왔다` |
| T3 | 시험 먼저 코드 묶음, 시험만 묶음 | 시험 고정: 시험 파일(`isTestPath`)을 바꾼 마지막 시험 쪽 커밋(`acting === 'test'`)보다 뒤에 review 커밋(계획 파일 '리뷰' 절을 바꿔 센 것)이 있다 | `[차례] 시험 파일을 고친 마지막 시험 쪽 커밋 뒤에 review 커밋이 없다(시험 고정 전 시험 리뷰, ADR-0372)` — 그 시험 쪽 커밋의 해시를 단다 |
| T4 | 정방향 묶음(`Batch-Order: impl-first`) | 구성: plan·test·impl. review·verify는 없어도 된다. 있으면 지금의 FORWARD 차례(review·verify는 첫 test·impl 뒤)를 지킨다. T3은 쓰지 않는다 | 지금과 같은 꼴 |
| T5 | 시험만 묶음(`Batch-Kind: test-only`) | 구성: plan·test·review. verify는 없어도 된다. 차례 plan < test < review(지금과 같음) | 지금과 같은 꼴 |
| T6 | 모든 비문서 묶음 | 마지막 verify가 마지막 고침보다 뒤라는 규칙은 verify 커밋이 있을 때만 본다(지금과 같음) | 지금과 같음 |
| T7 | 계획 파일 | 비문서 묶음: '실패 확인'·'담당 표'는 늘 요구. '리뷰'는 그 묶음에 review 커밋이 있거나 T1·T5 묶음이면 요구. '검증'은 verify 커밋이 있을 때만 요구. 문서 묶음은 지금과 같다('리뷰'·'담당 표') | `[계획 파일] <경로>에 '<절>' 절(## 또는 ###)이 없다` / `… 절이 비었다` |
| T8 | 그대로 둠 | 꼬리말, 범위(합치기 커밋), 구현 커밋의 시험 파일 금지, 코드 경로, 세션 한 역할, review·verify 커밋이 자기 절을 바꿔야 셈, review-fix는 첫 review·verify 뒤, Fix-By: impl 앞의 Fix-By: test, 담당 표 | 지금과 같음 |

- 2026-11-23 앞에 시작해 `Batch-Order` 없이 옛 시험 먼저 차례(plan < test < impl < review)로 간 묶음은 T2에서 실패한다. 받아들인다(갈래에는 그런 실패를 합치기 막음으로 보지 말라고 알렸다).

## 3. 시험 목록(시험 담당)

`tools/ci/roles-check.test.mjs`에 이미 있는 가짜 저장소 만들기 도우미를 써서 아래를 더한다. 시험 이름에 `ADR-0372 T<번호>`를 단다. 기존 시험 가운데 위 규칙과 어긋나는 기대(예: 코드 묶음에 verify가 없으면 실패, 시험 먼저 코드 묶음에서 review가 impl 뒤)는 새 규칙에 맞게 고치고, 무엇을 왜 고쳤는지 '실패 확인' 절에 적는다.

1. T1 통과: plan → test → review → impl(계획 파일에 '실패 확인'·'리뷰'·'담당 표', '검증' 절 없음) — 통과(끝 코드 0)
2. T1 실패: plan → test → impl(review 없음) — `[구성]`에 review
3. T2 실패: plan → test → impl → review — `[차례] 첫 impl 커밋이 첫 review 커밋보다 먼저 왔다`
4. T3 통과: plan → test → review → review-fix(Fix-By: test, 시험 파일) → review → impl — 통과
5. T3 실패: plan → test → review → review-fix(Fix-By: test, 시험 파일) → impl — 고정 실패, 해시는 그 review-fix 커밋
6. T3 실패(시험 이의): plan → test → review → impl → test(시험 파일) — 고정 실패. 같은 차례 뒤에 review가 하나 더 오면 통과
7. T3 경계: 시험 쪽 커밋이 시험 파일을 바꾸지 않고 `.md`만 바꿨으면 고정 실패가 아니다
8. T4 통과: `Batch-Order: impl-first`로 plan → impl → test(review·verify 없음) — 통과
9. T4 차례 유지: 정방향 묶음에서 review가 첫 test보다 먼저면 지금처럼 `[차례]` 실패
10. T5 통과: test-only로 plan → test → review(verify 없음) — 통과. review 없으면 `[구성]`
11. T6: 시험 먼저 코드 묶음에 verify가 있고 그 뒤에 impl 고침이 오면 지금처럼 `[차례] 마지막 코드 고침 커밋 뒤에 verify 커밋이 없다`
12. T7: verify 없는 묶음에 '검증' 절이 없어도 통과. verify가 있는데 '검증' 절이 없으면 실패. T1 묶음에 '리뷰' 절이 없으면 실패. 정방향 묶음에 review가 없고 '리뷰' 절이 없어도 통과
13. 문서 묶음은 그대로(계획·작성·리뷰, 기존 시험 유지)

## 4. 실패 확인

(시험 담당이 적는다: 기준 커밋에서 새 시험을 돌린 명령, 시험 수, 실패 수, 실패 까닭 한 줄. 고친 기존 시험 목록과 까닭)

## 5. 시험 이의

(구현 담당이 시험이 이 계획·ADR과 어긋난다고 볼 때 적는다)

## 6. 리뷰

(시험 리뷰 담당이 적는다: 지적 번호·등급·내용, 반영 확인)

## 7. 시험 결과

(구현 담당이 적는다: `node --test tools/ci/roles-check.test.mjs`와 `node --test "tools/ci/*.test.mjs"` 결과 숫자)

## 8. 담당 표

| 역할 | 세션 ID | 모델 | 시작 | 끝 |
| --- | --- | --- | --- | --- |
| plan | coord-fw1-8751836b | claude-opus-5-5 | 2026-11-23T10:00+09:00 | 2026-11-23T10:30+09:00 |
