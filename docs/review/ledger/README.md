# 완성 장부

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다(ADR-0256 결정 2, docs/architecture.md §8.6). 손으로 고치지 않는다. 손으로 정하는 상태·등급·사유는 `docs/review/ledger-notes.md`에 쓴다. 분야마다 항목 목록은 이 폴더의 `<분야>.md`에 있다.

## 완성 판정

- 항목 3649개: 시험 시나리오(세부 단위) 1609, 시나리오가 가리키지 않는 요구사항·정책 15, ASVS 추적 표의 행 2025
- 빈칸 1153, ID만 1118: 완성본은 둘 다 0이다(묶음은 `node tools/ci/ledger.mjs --batch <묶음> --require`로 그 범위만 본다)
- ID만의 뜻: 시나리오는 이름에 ID만 있고 그 세부 번호가 없는 시험만 있다. ASVS는 다른 곳 시험만 있는 경우도 ID만이다(같은 ID의 태그가 그 행의 코드 영역 밖 시험 파일에만 있다)
- 미검증 3(모두 사유가 있다): 완료로 세지 않고 따로 센다
- 다시 볼 notes 2: notes는 다른 단계·미검증인데 이름을 단 시험이 이미 있다

## 등급별 상태

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 244 | 91 | 21 | 2 | 2 | 39 | 1 | 0 | 182 | 582 |
| B | 780 | 1027 | 13 | 2 | 1 | 28 | 0 | 245 | 969 | 3065 |
| C | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| 합계 | 1024 | 1118 | 34 | 4 | 3 | 67 | 1 | 245 | 1153 | 3649 |

## 분야별 상태

| 분야 | 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| analytics | B | 0 | 102 | 0 | 0 | 0 | 0 | 0 | 29 | 57 | 188 |
| bot-defense | B | 111 | 19 | 0 | 0 | 0 | 6 | 0 | 0 | 16 | 152 |
| catalog-review | B | 52 | 25 | 0 | 0 | 0 | 0 | 0 | 16 | 23 | 116 |
| control-tower | B | 1 | 102 | 0 | 0 | 0 | 3 | 0 | 24 | 162 | 292 |
| delivery | B | 25 | 35 | 0 | 0 | 0 | 0 | 0 | 3 | 14 | 77 |
| devops | B | 24 | 7 | 0 | 0 | 1 | 0 | 0 | 0 | 74 | 106 |
| forensic-replay | B | 2 | 107 | 0 | 0 | 0 | 3 | 0 | 19 | 60 | 191 |
| frontend | B | 77 | 42 | 8 | 2 | 0 | 1 | 0 | 22 | 51 | 203 |
| identity | B | 217 | 56 | 0 | 0 | 0 | 5 | 0 | 7 | 95 | 380 |
| notify | B | 0 | 102 | 0 | 0 | 0 | 0 | 0 | 21 | 56 | 179 |
| offline-gate | B | 5 | 101 | 0 | 0 | 0 | 1 | 0 | 19 | 106 | 232 |
| payment | A | 70 | 26 | 6 | 0 | 2 | 12 | 0 | 0 | 0 | 116 |
| payment | B | 56 | 19 | 0 | 0 | 0 | 0 | 0 | 0 | 14 | 89 |
| queue-admission | A | 94 | 49 | 2 | 0 | 0 | 4 | 0 | 0 | 42 | 191 |
| queue-admission | B | 33 | 12 | 0 | 0 | 0 | 3 | 0 | 2 | 9 | 59 |
| requirements | A | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| requirements | B | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 | 12 |
| requirements | C | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| search | B | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 17 |
| seat-hold | A | 79 | 13 | 13 | 2 | 0 | 23 | 1 | 0 | 0 | 131 |
| seat-hold | B | 81 | 30 | 0 | 0 | 0 | 4 | 0 | 15 | 26 | 156 |
| security | B | 17 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 34 | 57 |
| settlement | A | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 38 | 41 |
| settlement | B | 0 | 98 | 0 | 0 | 0 | 0 | 0 | 23 | 32 | 153 |
| streaming | B | 3 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 23 | 27 |
| support | B | 0 | 63 | 0 | 0 | 0 | 0 | 0 | 22 | 16 | 101 |
| transfer-refund | A | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 102 | 102 |
| transfer-refund | B | 0 | 86 | 0 | 0 | 0 | 0 | 0 | 20 | 20 | 126 |
| v0-baseline | B | 28 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 31 |
| verification | B | 34 | 3 | 5 | 0 | 0 | 2 | 0 | 0 | 59 | 103 |
| verification-tools | B | 9 | 7 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 18 |
| 합계 |  | 1024 | 1118 | 34 | 4 | 3 | 67 | 1 | 245 | 1153 | 3649 |

## 다시 볼 notes

| 항목 | notes 상태 | 이름을 단 시험 |
| --- | --- | --- |
| O-T23 | 다른 단계 | services/v0-monolith/test-int/gate.int.test.ts |
| seat-hold:v5.0.0-2.3.2 | 다른 단계 | packages/validation/test/sale-policy.test.ts, services/purchase-svc/test-int/order-store.int.test.ts… |

## 정본에 없는 ID·세부 번호를 단 시험 이름

- I-T51 ①: tools/poc/login-compare/login-compare.test.mjs
- I-T51 ⑥: tools/poc/login-compare/login-compare.test.mjs
- Q-T64 ⑤: services/queue-svc/test/admission-cases.ts
- S-T30 ①: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ②: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ③: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ④: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts

## 표 읽기 경고

- docs/devops.md:912: D-T36 시나리오 칸의 ⑦이 판정 칸에 없어 세부로 세지 않는다
- docs/features/identity.md:732: I-T51 시나리오 칸의 ①⑥이 판정 칸에 없어 세부로 세지 않는다
- docs/features/identity.md:754: I-T73 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다
- docs/features/queue-admission.md:707: Q-T64 시나리오 칸의 ⑤이 판정 칸에 없어 세부로 세지 않는다
- docs/features/seat-hold.md:551: S-T30 시나리오 칸의 ①②③④이 판정 칸에 없어 세부로 세지 않는다
- docs/frontend.md:1615: FE-T29 시나리오 칸의 ①②④이 판정 칸에 없어 세부로 세지 않는다
- docs/frontend.md:1620: FE-T34 시나리오 칸의 ②이 판정 칸에 없어 세부로 세지 않는다
- docs/security/authz-matrix.md:334: AZ-T15 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다
- docs/verification.md:628: V-T32 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다

## 이 도구의 한계

- 시험이 통과했는지는 보지 않는다. 통과는 `tools/ci/trace-check.mjs`가 시험 보고서로 본다(docs/architecture.md §8.6의 대조).
- 이름만 본다. 이름에 ID와 세부 번호를 단 시험이 그 판정 기준을 실제로 검사하는지는 모른다. 그것은 ADR-0256 결정 3의 판정 기준 대조와 틀린 구현 검사의 몫이다.
- 이름은 원본의 글자로 읽는다(test·it·describe·suite·bench의 첫 인자, 템플릿의 `${…}`는 그대로). 변수로 만든 이름(`test(name, …)`)은 읽지 못한다. describe 이름도 하나의 이름으로 세므로, describe에 단 ID·세부 번호는 그 안 시험 모두의 것이 된다.
- 세부 번호는 ID 바로 뒤에 붙은 묶음만 센다('S-T23 ① … ③ …'의 ③은 세지 않는다). js·ts·mjs 시험만 읽는다(파이썬·Lua·k6 스크립트는 읽지 않는다).
- ASVS 태그는 그 행의 코드 영역 안 시험 파일의 것만 센다. 영역은 구현 위치 칸이 가리키는 코드(경로의 앞 두 마디, 서비스·앱 이름)이고, 가리키는 것이 없으면 ASVS 문서별 기본 영역(`tools/ci/ledger.mjs`의 `ASVS_DEFAULT_AREA`, 아직 코드가 없는 기능은 빈 목록)이다. 영역은 폴더 단위라, 같은 서비스 안의 다른 기능 시험이 같은 ID 태그를 달면 그것도 센다. `tools/ci/asvs-report.mjs`는 영역 없이 ID 단위로 센다.
- 판정 기준은 동그라미 번호로만 나눈다. 번호 없는 판정 기준 안의 여러 조건은 항목 하나로 센다.
- notes가 적은 상태가 시험 이름보다 앞선다. notes가 다른 단계·미검증인데 이름을 단 시험이 이미 있으면 위 '다시 볼 notes'에 보인다.
