# 완성 장부

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다(ADR-0256 결정 2, docs/architecture.md §8.6). 손으로 고치지 않는다. 손으로 정하는 상태·등급·사유는 `docs/review/ledger-notes.md`에 쓴다. 분야마다 항목 목록은 이 폴더의 `<분야>.md`에 있다.

## 완성 판정

- 항목 4109개: 시험 시나리오(세부 단위) 2068, 시나리오가 가리키지 않는 요구사항·정책 14, ASVS 추적 표의 행 2027
- 빈칸 727, ID만 1009: 완성본은 둘 다 0이다(묶음은 `node tools/ci/ledger.mjs --batch <묶음> --require`로 그 범위만 본다. `--require`는 빈칸·ID만·미검증·다른 단계를 실패로 세고, 옛 묶음은 `--allow-unverified`로 미검증·다른 단계를 통과시킨다)
- ID만의 뜻: 시나리오는 이름에 ID만 있고 그 세부 번호가 없는 시험만 있다. ASVS는 다른 곳 시험만 있는 경우도 ID만이다(같은 ID의 태그가 그 행의 코드 영역 밖 시험 파일에만 있다)
- 미검증 4(모두 사유가 있다): 완료로 세지 않고 따로 센다
- 다시 볼 notes 9: notes는 다른 단계·미검증인데 이름을 단 시험이 이미 있다

## 등급별 상태

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 610 | 99 | 24 | 2 | 2 | 18 | 1 | 0 | 115 | 871 |
| B | 1364 | 910 | 22 | 2 | 2 | 80 | 0 | 245 | 611 | 3236 |
| C | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 2 |
| 합계 | 1974 | 1009 | 46 | 5 | 4 | 98 | 1 | 245 | 727 | 4109 |

## 분야별 상태

| 분야 | 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| analytics | B | 0 | 118 | 0 | 0 | 0 | 0 | 0 | 29 | 41 | 188 |
| bot-defense | B | 122 | 21 | 0 | 0 | 0 | 6 | 0 | 0 | 10 | 159 |
| catalog-review | B | 69 | 22 | 0 | 0 | 0 | 0 | 0 | 16 | 9 | 116 |
| control-tower | B | 64 | 102 | 0 | 0 | 0 | 10 | 0 | 24 | 126 | 326 |
| delivery | B | 46 | 22 | 0 | 0 | 0 | 2 | 0 | 3 | 4 | 77 |
| devops | B | 72 | 0 | 2 | 0 | 1 | 1 | 0 | 0 | 42 | 118 |
| forensic-replay | B | 17 | 111 | 0 | 0 | 0 | 3 | 0 | 19 | 41 | 191 |
| frontend | B | 88 | 46 | 8 | 2 | 0 | 3 | 0 | 22 | 34 | 203 |
| identity | A | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |
| identity | B | 325 | 46 | 0 | 0 | 0 | 6 | 0 | 7 | 58 | 442 |
| notify | B | 10 | 119 | 0 | 0 | 0 | 0 | 0 | 21 | 37 | 187 |
| offline-gate | B | 49 | 104 | 0 | 0 | 0 | 11 | 0 | 19 | 65 | 248 |
| payment | A | 165 | 24 | 6 | 0 | 2 | 10 | 0 | 0 | 0 | 207 |
| payment | B | 58 | 0 | 0 | 0 | 0 | 31 | 0 | 0 | 0 | 89 |
| queue-admission | A | 115 | 46 | 3 | 0 | 0 | 2 | 0 | 0 | 30 | 196 |
| queue-admission | B | 36 | 14 | 0 | 0 | 0 | 3 | 0 | 2 | 4 | 59 |
| requirements | A | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| requirements | B | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 9 | 11 |
| requirements | C | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 2 |
| search | B | 19 | 0 | 2 | 0 | 1 | 1 | 0 | 0 | 0 | 23 |
| seat-hold | A | 132 | 13 | 15 | 2 | 0 | 6 | 1 | 0 | 0 | 169 |
| seat-hold | B | 111 | 18 | 0 | 0 | 0 | 3 | 0 | 15 | 9 | 156 |
| security | B | 48 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 26 | 81 |
| settlement | A | 76 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 104 |
| settlement | B | 70 | 46 | 0 | 0 | 0 | 0 | 0 | 23 | 14 | 153 |
| streaming | B | 5 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 20 | 27 |
| support | B | 0 | 74 | 0 | 0 | 0 | 0 | 0 | 22 | 5 | 101 |
| transfer-refund | A | 108 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 65 | 181 |
| transfer-refund | B | 77 | 26 | 0 | 0 | 0 | 0 | 0 | 20 | 6 | 129 |
| v0-baseline | B | 28 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 31 |
| verification | A | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| verification | B | 40 | 3 | 9 | 0 | 0 | 0 | 0 | 0 | 51 | 103 |
| verification-tools | B | 9 | 7 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 18 |
| 합계 |  | 1974 | 1009 | 46 | 5 | 4 | 98 | 1 | 245 | 727 | 4109 |

## 다시 볼 notes

| 항목 | notes 상태 | 이름을 단 시험 |
| --- | --- | --- |
| D-T18 ② | 다른 단계 | tools/local/e2e/kyverno.e2e.mjs |
| C-T43 | 다른 단계 | services/core-svc/test-int/ops-event.int.test.ts, services/core-svc/test/change-event-scale.test.ts… |
| O-T23 | 다른 단계 | services/v0-monolith/test-int/gate.int.test.ts |
| P-T39 ① | 다른 단계 | services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/apply-payment-result.test.ts… |
| P-T39 ② | 다른 단계 | services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/ticket-issue-adapters.test.ts… |
| P-T39 ④ | 다른 단계 | services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/ticket-issue-adapters.test.ts… |
| payment:v5.0.0-3.3.2 | 다른 단계 | apps/web/src/features/staff-approval/flow.test.mjs, apps/web/src/features/staff-invitation/flow.test.mjs |
| payment:v5.0.0-3.4.5 | 다른 단계 | apps/web/src/shared/lib/staff-fragment.test.mjs, apps/web/src/widgets/app-shell/model/search-quality.test.mjs |
| payment:v5.0.0-3.5.3 | 다른 단계 | apps/web/src/_pages/ticket-cancel/ui/live-wiring.test.mjs |

## 정본에 없는 ID·세부 번호를 단 시험 이름

- I-T51 ①: tools/poc/login-compare/login-compare.test.mjs
- I-T51 ⑥: tools/poc/login-compare/login-compare.test.mjs
- Q-T64 ⑤: services/queue-svc/test/admission-cases.ts
- RF-T1: services/realtime-gw/test/degraded.test.ts
- RF-T10: services/realtime-gw/test/degraded.test.ts
- RF-T11: services/realtime-gw/test-int/stream.int.test.ts
- RF-T12: services/realtime-gw/test-int/stream.int.test.ts
- RF-T13: services/realtime-gw/test-int/stream.int.test.ts, services/realtime-gw/test/degraded.test.ts
- RF-T14: services/realtime-gw/test/degraded.test.ts
- RF-T2: services/realtime-gw/test/degraded.test.ts
- RF-T3: services/realtime-gw/test/degraded.test.ts
- RF-T4: services/realtime-gw/test/degraded.test.ts
- RF-T5: services/realtime-gw/test/degraded.test.ts
- RF-T6: services/realtime-gw/test/degraded.test.ts
- RF-T7: services/realtime-gw/test/degraded.test.ts
- RF-T8: services/realtime-gw/test/degraded.test.ts
- RF-T9: packages/platform/test/admission-token.test.ts, services/realtime-gw/test/degraded.test.ts
- S-T30 ①: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ②: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ③: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts
- S-T30 ④: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts

## 표 읽기 경고

- docs/features/identity.md:786: I-T51 시나리오 칸의 ①⑥이 판정 칸에 없어 세부로 세지 않는다
- docs/features/identity.md:808: I-T73 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다
- docs/features/payment.md:951: P-T73 시나리오 칸의 ⑥이 판정 칸에 없어 세부로 세지 않는다
- docs/features/payment.md:952: P-T74 시나리오 칸의 ⑦이 판정 칸에 없어 세부로 세지 않는다
- docs/features/queue-admission.md:716: Q-T64 시나리오 칸의 ⑤이 판정 칸에 없어 세부로 세지 않는다
- docs/features/seat-hold.md:595: S-T30 시나리오 칸의 ①②③④이 판정 칸에 없어 세부로 세지 않는다
- docs/frontend.md:1654: FE-T29 시나리오 칸의 ①②④이 판정 칸에 없어 세부로 세지 않는다
- docs/frontend.md:1659: FE-T34 시나리오 칸의 ②이 판정 칸에 없어 세부로 세지 않는다
- docs/security/authz-matrix.md:367: AZ-T15 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다
- docs/security/authz-matrix.md:371: AZ-T18 ①가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ②가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ③가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ④가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ⑤가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ⑥가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/security/authz-matrix.md:371: AZ-T18 ⑦가 docs/security/authz-matrix.md:370에도 있어 뒤의 것은 뺀다
- docs/verification.md:657: V-T32 시나리오 칸의 ①이 판정 칸에 없어 세부로 세지 않는다

## 이 도구의 한계

- 시험이 통과했는지는 보지 않는다. 통과는 `tools/ci/trace-check.mjs`가 시험 보고서로 본다(docs/architecture.md §8.6의 대조).
- 이름만 본다. 이름에 ID와 세부 번호를 단 시험이 그 판정 기준을 실제로 검사하는지는 모른다. 그것은 ADR-0256 결정 3의 판정 기준 대조와 틀린 구현 검사의 몫이다.
- 이름은 원본의 글자로 읽는다(test·it·describe·suite·bench의 첫 인자, 템플릿의 `${…}`는 그대로). 변수로 만든 이름(`test(name, …)`)은 읽지 못한다. describe 이름도 하나의 이름으로 세므로, describe에 단 ID·세부 번호는 그 안 시험 모두의 것이 된다.
- 세부 번호는 ID 바로 뒤에 붙은 묶음만 센다('S-T23 ① … ③ …'의 ③은 세지 않는다). js·ts·mjs 시험만 읽는다(파이썬·Lua·k6 스크립트는 읽지 않는다).
- ASVS 태그는 그 행의 코드 영역 안 시험 파일의 것만 센다. 영역은 구현 위치 칸이 가리키는 코드(경로의 앞 두 마디, 서비스·앱 이름)이고, 가리키는 것이 없으면 ASVS 문서별 기본 영역(`tools/ci/ledger.mjs`의 `ASVS_DEFAULT_AREA`, 아직 코드가 없는 기능은 빈 목록)이다. 영역은 폴더 단위라, 같은 서비스 안의 다른 기능 시험이 같은 ID 태그를 달면 그것도 센다. `tools/ci/asvs-report.mjs`는 영역 없이 ID 단위로 센다.
- 판정 기준은 동그라미 번호로만 나눈다. 번호 없는 판정 기준 안의 여러 조건은 항목 하나로 센다.
- notes가 적은 상태가 시험 이름보다 앞선다. notes가 다른 단계·미검증인데 이름을 단 시험이 이미 있으면 위 '다시 볼 notes'에 보인다.
