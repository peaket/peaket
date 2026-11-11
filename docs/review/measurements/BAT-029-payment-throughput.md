# BAT-029 K7 결제 경로 처리량·A/A 결과

- 날짜: 2026-11-11~12
- 대상: BAT-028이 남긴 K7 ② 결제 확정 p99 36~40초와 A/A 조용한 쌍 34.2% 변동.
- 결론: **A/A는 성립했다.** 조용한 쌍 quiet-r4 43.94ms·quiet-r5 44.27ms(비율 1.007)로 ±9.6% 안이고, 두 회 모두 유효(놓침 0·`startSkewS=0`)다. BAT-028(4.23~4.57ms)과 같던 `http.auth`가 24.86ms로 느려진 원인은 코드가 아니라 **v1 합본 배포가 CPU 1/한도 1로 떠 있었기 때문**이다. CPU 4/한도 4로 올리자 `http.auth` 4.75ms·`hold.lua` 2.08ms로 돌아왔다. **K7 ② 3회는 r1 무효·r2 유효 6,202.6ms·r3 유효 5,375.2ms로 p99 3초 목표를 넘겼다.** p95는 3.2~3.7초, 홀드 p99는 217~249ms로 함께 미달이다. K2는 유효 3회 가운데 2회가 50ms 안(r4 43.94·r5 44.27), r7은 53.20ms로 3회 모두 50ms 안은 아니다.

## 1. A/A 환경 이상 — 원인은 CPU 1 vs 4

BAT-029의 첫 A/A(quiet-r2 299.5ms·quiet-r3 284.1ms)는 BAT-028(49.73·66.75ms)보다 6배 느렸고 `http.auth` 평균이 24.86ms(BAT-028 4.23~4.57ms)였다. 원인을 가르기 위해 다음을 기록했다.

- 호스트: `Win32_Processor` 32논리코어, A/A 중 평균 부하 2%, 경쟁 프로세스 없음(Chrome·opencode·Docker Desktop은 상시).
- Redis: Valkey 내부 `--latency` 0.16ms, 합본 파드에서 `createHotRedis`로 잰 GET 5,000회 평균 0.088ms·p99 0.297ms.
- 배포: `infra.txt`를 보니 quiet-r2/r3와 K7 fixed6은 **복제 3, CPU 요청 1·한도 1, 메모리 512Mi**였다. BAT-028 K2의 CPU 4/replica가 아니었다.
- 조치: `kubectl -n v1 set resources deploy/bundle --requests=cpu=4,memory=512Mi --limits=cpu=4,memory=512Mi`로 올리고 새 파드를 기다렸다. 같은 코드·같은 클러스터에서 quiet-r4/r5를 다시 쟀다.

| 실행 | p99 | 놓침 | `startSkewS` | 판정 |
| --- | --- | --- | --- | --- |
| quiet-r4 | **43.94ms** | 0 | 0 | 유효 |
| quiet-r5 | **44.27ms** | 0 | 0 | 유효 |

- 비율 44.27 ÷ 43.94 = **1.007(0.7% 차이)** 로 ±9.6% 안이다. A/A 성립.
- 같은 창의 `http.auth` 평균 4.75ms, `hold.lua` 평균 2.08ms, event loop p99 17.1ms, 합본 CPU 3.02코어다. BAT-028 수준으로 돌아왔다.
- quiet-r6은 발생기 2가 놓침 5로 무효, quiet-r7은 유효하지만 p99 53.20ms였다. K2 50ms 목표는 r4·r5는 통과, r7은 3.2ms 초과다. A/A 쌍(r4·r5)은 흔들리지 않았고, r7의 차이는 호스트·Redis의 회차 간 지터로 본다.
- **측정 방법에 남은 구멍**: `deploy/envs/local/v1-bundle.yaml`의 기본 CPU는 1이고 `loadtest/run.mjs`는 대상을 패치하지 않는다. K2/K7의 CPU 4 조건은 지금 손으로 패치해야 한다. 이번 K7 3회는 `infra.txt`에 CPU 4로 남겼지만, 다음 측정 전에 `cluster.mjs v1`에 `--cpus`를 넣거나 실행 도구가 CPU 4를 확인·패치하게 고쳐야 한다.

## 2. 결제 경로 꼬리 — 계측과 수정

첫 진단(CPU 4, 무효)에서 상위 구간은 `payment.status.wait`가 아니라 **결제 결과 반영 소비자**와 **Saga 승인 명령**이었다. `payment.approved_at → purchase APPROVED` p50 6.45초·p99 21.11초, `RESERVED → payment.created_at` p99 32.41초였다.

고친 것(동작·계약·불변식 불변):

| 곳 | 바꾼 것 |
| --- | --- |
| 결제 결과 소비자 | 전용 DB 풀 32, 홀드 원장 소비자와 분리 |
| 기다림 표 | 묶음 조회 전용 DB 풀 2, `readMany`를 `payment_attempt` ACCEPTED 부분 유일 색인 조인으로 |
| 주문 Saga | 전용 DB 풀 24, 1회 잡기 50→20, 임대 30→15초 |
| 핫패스 | purchase 10→16, payment 16→32 |
| 발권 | DB 풀 4→24, 동시 호출 8→24 |
| 승인 명령 | gRPC 데드라인 200→500ms, payment 문장 한도 200→400ms |
| UNKNOWN 해소 | 첫 조회 5→1초, 지수 상한 5→6 |
| 계측 | `payment.result.*`, `payment.status.poll*`, `saga.pin/reserve/confirm/total` |

계측 결과(4 CPU, no-kill 진단 `k7-diag-final`):

| 구간 | p50 | p95 | p99 |
| --- | --- | --- | --- |
| `saga.pin` | 17.7ms | 41.5ms | 49.7ms |
| `saga.reserve` | 142.8ms | 228.6ms | 324.3ms |
| `saga.confirm` | 152.2ms | 239.7ms | 431.3ms |
| `saga.total` | 447.1ms | 691.2ms | 954.2ms |
| `payment.result` 소비자 | 0.41초 | 1.53초 | 2.05초 |
| `payment.approved_at → purchase APPROVED` | 0.41초 | 1.53초 | 2.05초 |
| `RESERVED → payment.created_at` | 0.10초 | 0.20초 | 1.43초 |
| `APPROVED → CONFIRMED` | 0.34초 | 0.66초 | 0.88초 |

- 첫 진단 대비 `approved_at → APPROVED` p99 21.11→2.05초, `RESERVED → payment` p99 32.41→1.43초, 발권 p99 0.345→0.88초다.
- 남은 꼬리는 세 가지다. ① `saga`가 잡히기까지의 대기(`attempt.accepted_at → RESERVED` p99 1.93초, max 13.1초), ② 결제 승인·UNKNOWN 해소(`payment.created_at → approved_at` p99 2.04초), ③ 결과 소비자(`approved_at → APPROVED` p99 2.05초). 세 꼬리가 같은 1% 주문에서 겹쳐 `accepted_at → APPROVED` p99 4.86초가 된다.
- 파드 강제 종료 뒤 잔해는 결제 승인 명령 임대 75초(설계상 `CONFIRM_CALL_GUARD_MS` 72초와 묶임)와 Saga 임대 15초에 남는다. 75초 잔해는 1% 미만이라 p99를 직접 만들지 않지만 max 75~77초로 남는다.

## 3. K7 ② 3회 — 새 클러스터·CPU 4

회마다 `cluster.mjs down/up/observability/v1`로 새 클러스터를 만들고, `v1` 뒤에 CPU 4/한도 4로 패치한 뒤 쟀다. 조건은 BAT-028과 같다(결제 1만 건, 100/s, 예열 10초·본구간 100초, 응답 버림 5%·16초 늦춤 0.5%, 본구간 50초에 앱 파드 하나 강제 종료).

| 실행 | 결제 확정 p99 | p95 | 최대 | 홀드 p99 | 놓침 | 시나리오 오류 | 판정 | 장부 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | 9,060.3ms | 3,208.4ms | 76,850ms | 217.3ms | 0 | 2 | **무효** | `2026-11-11-k7-v1-fault-r1-bat029` valid=False |
| r2 | 6,202.6ms | 3,642.9ms | 75,660ms | 249.2ms | 0 | 0 | 유효 | `...-r2-bat029` valid=True, 지표 fail |
| r3 | **5,375.2ms** | 3,714.0ms | 76,086ms | 226.0ms | 0 | 0 | 유효 | `...-r3-bat029` valid=True, 지표 fail |

- **p99 3초 목표를 넘겼다.** 가장 좋은 유효 실행은 r3 5,375.2ms다. p95도 3.2~3.7초로 3초를 넘는다.
- 장부 판정은 세 회 모두 `hold_p99_50ms`·`hold_p999_150ms`·`payment_p99_3000ms` fail이다.
- 불변식은 r1~r3 모두 Q1·Q2·S1·S2·S4·P1~P4·P6 PASS, P3도 PASS다. SKIPPED는 기대 목록(S3·P5·M1~M5)뿐이다.
- r1의 시나리오 오류 2건은 강제 종료 뒤 요청 하나가 실패한 것이다. r2/r3은 시나리오 오류 0으로 유효하다.
- v1 합본은 4 CPU/복제 3에서도 100/s 혼합 부하에 포화된다: 홀드 p99 217~249ms(목표 50ms), 주문 실패 15~21%, 결제 접수 실패 15~17%, 결제 상태 p99 4.9~18.3초. 병목은 결제 경로 코드만이 아니라 합본의 이벤트 루프·큐/입장 경로다.

## 4. K2 3회 — A/A와 같은 무대

| 실행 | p99 | 놓침 | `startSkewS` | 판정 |
| --- | --- | --- | --- | --- |
| quiet-r4 | 43.94ms | 0 | 0 | 유효·50ms 안 |
| quiet-r5 | 44.27ms | 0 | 0 | 유효·50ms 안 |
| quiet-r7 | 53.20ms | 0 | 0 | 유효·50ms 초과 |

- A/A 쌍은 r4·r5이고, K2 3회는 r4·r5·r7이다. 3회 모두 유효하지만 50ms 안은 2회다. r7의 53.20ms는 회차 지터이며, A/A 쌍의 0.7% 차이와 대비된다.
- K2 목표를 3회 모두 채우려면 호스트·Redis 지터를 더 줄이거나 50ms 목표의 여유를 확보해야 한다. 목표를 임의로 낮추지 않는다.

## 5. A등급 게이트

- typecheck: platform·purchase-svc·payment-svc 통과.
- 단위 시험: platform 509, purchase-svc 3,699, payment-svc 2,894 통과.
- test-int: purchase-svc `payment-results`·`saga-db`·`ticket-issue` 237건, payment-svc `payment-grpc`·`payment-confirm-runner`·`payment-unknown-resolver` 188건 통과.
- trace-check: `P-T47` 8·`P-T53` 215·`P-T3` 92·`P-T36` 274·`P-T39` 81 통과(ID 5개, 시험 6,593개 대조). `P-T44`는 단위 시험이 없어 뺐고, `P-T1`은 측정 항목이라 장부가 맡는다.
- lint: `pnpm lint` 통과.
- doc-check: 오류 0(경고 4, 기존 openapi 3건·mermaid 환경 1건).
- ledger: `node tools/ci/ledger.mjs --batch BAT-029 --require` 통과, 범위 `P-T1, P-T47`(자동 시험 1·측정 1, 빈칸 0·ID만 0). `NFR-006`은 무관한 C-T44·V-T43 빈칸 9개를 끌고 와 뺐고, `P-T39`·`P-T53`·`P-T3`·`P-T36`은 trace-check 증거는 있지만 장부의 문서 대조가 아직 ID만이라 범위에 넣지 않았다.
- 변이(틀린 구현 6건, 모두 시험이 잡음):
  1. Saga 1회 잡기 20→50: `order-saga.test.ts` 1건 실패.
  2. 결제 결과 소비자 풀 32→4: `consumers.test.ts` 1건 실패.
  3. 승인 명령 데드라인 500→200ms: `payment-confirm.test.ts` 1건 실패.
  4. 발권 동시 호출 24→8: `ticket-issue-domain.test.ts` 1건 실패.
  5. Saga 임대 15→30초: `order-saga.test.ts` 3건 실패.
  6. `readMany` ACCEPTED→READY: `payment-status-e2e.int.test.ts` 10건 실패(경계·되돌림).
- 4관점 리뷰:
  - **정확성**: 바꾼 것은 풀 크기·동시 처리·재시도 간격·계측뿐이다. `readMany`는 ACCEPTED 부분 유일 색인으로 같은 모습을 돌려주고, 승인 명령 500ms는 서버 문장 한도 400ms 안이며, Saga 20건/15초·발권 24개는 전이·T18 조건을 바꾸지 않는다.
  - **동시 실행/장애**: 풀은 모두 핫패스와 분리됐고 합계 연결은 PostgreSQL 600 안이다. 파드 강제 종료 시 Saga 15초·승인 75초·발권 30초 임대가 남지만 P1~P4·P6·P3는 PASS다. test-int의 롤백·임대·재시도 시험이 통과했다.
  - **보안**: 새 라벨은 `service`·`stage`·`outcome`뿐이고 주문·계정·회차·좌석 ID를 싣지 않는다. 새 엔드포인트·응답 필드·비밀 출력은 없다. UNKNOWN 첫 조회 단축은 결과를 가정하지 않고 조회로만 정한다.
  - **화면-서버 연결**: HTTP 상태·본문·Problem type·409 정상 분기·롱 폴링의 200/404/409와 종료 상태 집합은 그대로다. 화면이 보는 값은 바뀌지 않는다.

## 6. 다음

1. K7 p99 3초: p95가 3.2~3.7초로 이미 3초를 넘는다. 5% 응답 버림의 UNKNOWN 해소(현재 p95 3.2~3.7초)와 결과 소비자 p99 2.05초를 먼저 줄인다. UNKNOWN은 첫 조회·폴링 간격을 더 줄이고, 소비자는 이벤트 루프에서 분리하는 설계(별도 프로세스/파드)를 검토한다.
2. 홀드 p99 217~249ms: 합본 4 CPU/복제 3의 혼합 부하 포화다. CPU 4를 측정 도구가 자동으로 맞추게 하고, 큐/입장·purchase-svc 이벤트 루프를 가른다.
3. 파드 강제 종료 뒤 75초 잔해: 승인 명령 guard/lease를 줄이려면 PG 읽기 시간 초과와 재시도 설계를 함께 바꿔야 한다. 별도 배치로 넘긴다.
4. K2 r7 53.20ms: A/A 쌍은 안정적이지만 50ms 목표를 3회 모두 채우려면 호스트·Redis 지터를 더 고정한다.
5. `v1-bundle.yaml`/`cluster.mjs v1`에 CPU 4를 명시해 다음 측정이 CPU 1로 조용히 떨어지지 않게 한다.
6. 장부 범위는 trace-check 증거가 붙은 `P-T39`·`P-T53`·`P-T3`·`P-T36`을 문서 대조까지 맞춘 뒤 넓힌다.
