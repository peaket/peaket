# BAT-028 핫패스 최적화(D+A+B)

- 날짜: 2026-11-11
- 대상: BAT-027이 남긴 K2 2,000/s p99 47.54ms(무효)와 HTTP 입구·출구 차이 25.58ms, `hold.session` 중복 Redis GET.
- 결론: **D·A·B를 넣었고 K2 2,000/s CPU 4/replica 유효 3회가 p99 41.06·44.33·46.11ms(중앙값 44.33ms)로 정본 목표 50ms 안에 들었다.** BAT-027 계측 실행(47.54ms, 무효)보다 중앙값이 3.21ms 낮고, `hold.session` 중복 GET은 사라졌으며 HTTP 안에서는 `http.auth`가 가장 큰 몫(평균 4.23~4.57ms·p99 19.08~19.89ms)이다. **K7 ② 3회는 모두 발생기 놓침·시나리오 오류로 무효·미달**이고, **A/A 조용한 쌍은 34.2% 차이로 성립하지 않았다.** 새 클러스터 이미지 적재는 `preloadLocalImages`(fix(local), R-474)로 고쳐 v1 무대 기동을 확인했다. 이 문서는 K2·K7·A/A·게이트·리뷰를 남긴다.

## 1. D — 측정 방법

- v1 K2 좌석 홀드의 기본 예열을 **60초**로 늘렸다(`loadtest/runner/args.mjs` `V1_SEAT_HOLD_WARM_S`). K1·K7·v0는 기존 30초 기본을 그대로 쓴다(시험 `BAT028_K2_seat-hold_기본예열은60초이고_K1_K7_기본예열은30초그대로다`).
- 모든 발생기가 준비(setup: 사전 검증·진입·입장·구매 세션 열기)를 마친 뒤 같은 절대 시각에 예열을 시작한다.
  - 실행 도구가 `WARM_START_AT_MS`를 정해 발생기에 넘기고, `v1-seat-hold.js`의 `setup()`은 준비가 끝나면 그 시각까지 기다린다.
  - 실행 도구는 그 시각까지 기다렸다가 `loadStartMs`를 잡는다. 준비가 늦은 발생기는 그 발생기만 늦게 시작하고 `startSkewS`로 드러난다.
- K2 3회 모두 `startSkewS=0`이었고, 유효 3회의 dropped는 0이었다. 네 번째 실행(r3)은 발생기 0의 예열 구간 dropped 4로 무효였고 판정에 쓰지 않았다.

## 2. A — HTTP 입구·출구 계측

기존 `HotPathMetrics`에 `http.entry`·`http.auth`·`http.handler`·`http.problem`·`http.log`·`http.serialize`·`http.total`을 더했다. `createService`가 서비스의 `HotPathMetrics`를 받아 HTTP 훅·인증 가드·ProblemFilter에 같은 객체를 넘긴다. 라벨은 `service`·`stage`뿐이고 계정·주문·회차 ID는 싣지 않는다. 지표가 던져도 요청을 막지 않는다.

K2 유효 3회의 본구간 60초 표다(평균·p99, 표준 히스토그램).

| 구간 | r1 평균/p99 | r2 평균/p99 | r4 평균/p99 |
| --- | --- | --- | --- |
| `http.entry` | 0.075 / <5ms | 0.075 / <5ms | 0.076 / <5ms |
| `http.auth` | **4.23 / 19.08ms** | **4.32 / 19.25ms** | **4.57 / 19.89ms** |
| `http.handler` | 6.60 / 38.38ms | 6.76 / 40.19ms | 7.18 / 43.75ms |
| `http.problem` | 0.083 / <5ms | 0.084 / <5ms | 0.082 / <5ms |
| `http.log` | 0.055 / <5ms | 0.056 / <5ms | 0.055 / <5ms |
| `http.serialize` | 0.257 / <5ms | 0.263 / <5ms | 0.277 / <5ms |
| `http.total` | 6.94 / 39.70ms | 7.10 / 41.40ms | 7.53 / 44.57ms |
| `hold.total` | **2.16 / 9.92ms** | **2.22 / 10.00ms** | **2.36 / 13.76ms** |
| `hold.lua` | 1.82 / 9.42ms | 1.87 / 9.62ms | 2.00 / 10.20ms |
| `hold.session` | **관측 없음(제거됨)** | **관측 없음(제거됨)** | **관측 없음(제거됨)** |

- `http.auth`가 HTTP 안의 가장 큰 단일 몫이다. 구매 세션 `resolve`(Redis 읽기 1회)와 `advance`(Redis 쓰기 1회), MAC 검증을 포함한다.
- `http.problem`·`http.log`·`http.serialize`는 평균 0.3ms 미만이다. 409 문제 변환·정규 로그·응답 직렬화는 이번 K2에서 병목이 아니다.
- `http.handler`는 `http.auth`를 포함한다. `handler` p99에서 `auth` p99와 `hold.total` p99를 빼면 약 5~15ms가 남고, 이 몫은 처리기 앞뒤의 이벤트 루프 대기·프레임워크 비용으로 보인다. 다음 계측 후보로 남긴다.
- 표준 히스토그램 첫 칸(5ms)보다 짧은 구간의 p99는 `<5ms`로 적었다. 평균을 더 믿어야 한다.

## 3. B — 인증 세션 재사용

- 인증 훅(`StoredPurchaseSessions.resolve`)이 읽은 구매 세션 정보를 요청에 붙이고, `@CurrentPurchaseSessionInfo()`가 `HoldSeats.execute`에 넘긴다. `HoldSeats`는 세션이 넘어오면 `sessions.get`을 부르지 않는다. 넘어오지 않으면 기존처럼 부른다.
- 계정 대조·회차 대조·최대 체류 경계는 홀드가 다시 본다. 인증이 읽은 `maxStayUntilMs`를 함께 넘겨 인증과 홀드 사이의 경계 차이를 없앴다.
- K2에서 `hold.session` 관측이 사라졌다. BAT-027의 `hold.session` 평균 2.36ms·p99 11.42ms가 제거된 몫이다.
- HTTP 단위 시험에서 인증 훅 뒤 `sessions.get`을 부르지 않는 것을 확인했다. `MemoryPurchaseSessions`·`StoredPurchaseSessions` 모두 요청에 세션 정보를 붙인다.
- **한계**: 예전에는 인증 훅과 홀드 사이에 세션이 끝나면 두 번째 `get`이 401을 냈다. 이제는 인증 시점의 스냅샷을 쓰므로 그 좁은 구간의 종료는 홀드가 보지 못한다. 최대 체류 경계는 다시 보지만, 세션 종료 사건 자체는 인증 훅의 `resolve`·`advance` 시점까지만 확인한다. 이 동작 차이는 B의 중복 GET 제거에 따른 것이고, 기존 `http.test.ts`의 '인증 뒤 get이 비면 401' 시험을 '인증 뒤 get을 부르지 않는다' 시험으로 바꿔 기록했다. 보안상 인증이 유효한 요청만 홀드에 오고, 계정·회차·최대 체류는 다시 본다.

## 4. K2 2,000/s CPU 4/replica 3회

같은 클러스터·같은 방법(사용자 1,000명, hot 1, keep, 예열 60초·본구간 60초, 발생기 4대, 합본 CPU 4/복제 3). r3은 예열 dropped 4로 무효라 판정에서 뺐다.

| 실행 | p99 | p99.9 | 평균 | 건수 | 오류 | dropped | startSkew | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | 46.11ms | 126.76ms | 9.33ms | 120,001 | 0 | 0 | 0 | 유효 |
| r2 | 41.06ms | 95.01ms | 9.24ms | 120,000 | 0 | 0 | 0 | 유효 |
| r3 | 46.23ms | 105.57ms | 9.45ms | 119,997 | 0 | 4 | 0 | **무효** |
| r4 | 44.33ms | 78.66ms | 9.55ms | 120,000 | 0 | 0 | 0 | 유효 |

- 유효 3회 중앙값 **44.33ms**, 범위 41.06~46.11ms. 모두 50ms 안이고 p99.9도 150ms 안이다.
- BAT-027 계측 실행(p99 47.54ms, 무효)보다 중앙값이 3.21ms 낮다. D·B의 몫과 실행 변동이 섞여 있다.
- 발생기 CPU 평균 최고 27.6~27.9%, 메모리 최대 28.6~28.9%, VU 최대 합 801. 발생기는 포화가 아니다.
- HTTP 서버 p99는 39.70·41.40·44.57ms였고, k6 p99와 같은 방향이다.
- 합본 CPU는 2.86~2.91코어(12코어의 약 24%), event loop p99 최대 16.0~17.4ms였다.

## 5. K7 ② 3회

먼저 새 클러스터의 이미지 적재를 고쳤다(`fix(local)`, R-474). 고정 다이제스트 대신 로컬 태그를 쓰고, `cluster.mjs`의 `preloadLocalImages`가 `docker save --platform`→`kind load image-archive`로 Strimzi·Kafka·Prometheus·Grafana·Postgres·Valkey·moto·합본 이미지를 새 노드에 미리 넣는다. 새 클러스터에서 `up`·`observability`·`v1`이 정상 기동하는 것을 확인했다.

K7 ②는 회마다 새 클러스터(합본 CPU 4/replica 3)에서 같은 조건(결제 1만 건, 100/s, 예열 10초·본구간 100초, 응답 버림 5%·16초 늦춤 0.5%, 본구간 50초에 앱 파드 하나 강제 종료)으로 3회 돌렸다.

| 실행 | k6 p99 | 오류율 | 요청 | 놓침 | 시나리오 오류 | 홀드 p99 | 결제 확정 p99 | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r1 | 13,226ms | 9.45% | 46,665 | 435 | 1 | 236.3ms | 36.3s | **무효·미달** |
| r2 | 14,208ms | 11.79% | 40,401 | 991 | 102 | 419.4ms | 38.5s | **무효·미달** |
| r3 | 14,462ms | 10.90% | 45,183 | 420 | 16 | 189.0ms | 39.7s | **무효·미달** |

- 세 회 모두 발생기 놓침(435·991·420)과 시나리오 오류(1·102·16)로 무효다. 장부 판정도 `hold_p99_50ms`·`hold_p999_150ms`·`payment_p99_3000ms` 모두 fail이다.
- 불변식은 세 회 모두 P1~P4·P6·S1·S2·S4·Q1·Q2 PASS, SKIPPED는 기대 목록(S3·P5·M1~M5)뿐이고 **P3은 PASS**다. 강제 종료 뒤 이중 결제·승인 뒤 60초 위반은 없었다.
- K7 ②의 실패는 B/A/D가 만든 회귀가 아니라 이 무대의 결제 경로 처리량·발생기 한계다. BAT-025 K7 ②도 같은 이유로 무효·미달이었고, 이번에도 결제 확정 p99가 36~40초, 롱 폴링 p99가 25초대다. K7 목표 통과는 별도 결제 경로 최적화 배치가 필요하다.

## 6. A/A

A/A는 K2와 같은 조건(사용자 1,000명·2,000/s·hot 1·keep·예열 60초·본구간 60초·발생기 4대)에서 조용한 쌍과 의도한 잡음(noise) 쌍을 쟀다.

| 실행 | 조건 | p99 | p99.9 | 놓침 | 오류 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| quiet-r1 | 조용 | 84.48ms | 180.88ms | 87 | 0 | 무효(버림) |
| quiet-r2 | 조용 | 49.73ms | 98.63ms | 0 | 0 | 유효 |
| quiet-r3 | 조용 | 66.75ms | 108.34ms | 0 | 0 | 유효 |
| noisy-r1 | purchase-svc 시험 반복(너무 무거움) | 3,970.8ms | 15,230ms | 58,692 | 69.0% | 무효(버림) |
| noisy-r2 | noise2(pnpm 실패로 잡음 없음) | 136.31ms | 200.83ms | 13 | 0 | 무효(버림) |
| noisy-r3 | noise2(pnpm 실패로 잡음 없음) | 93.75ms | 189.04ms | 103 | 0 | 무효(버림) |
| noisy-r4 | args090 시험 반복 | 99.24ms | 154.49ms | 14 | 0 | 무효 |
| noisy-r5 | args090 시험 반복 | 69.17ms | 169.36ms | 0 | 0 | 유효 |

- **조용한 쌍**: quiet-r2 49.73ms와 quiet-r3 66.75ms의 비율은 **1.342(34.2% 차이)** 로, 이 PC의 A/A 기준(±9.6%)을 크게 넘는다. 조용한 쌍은 성립하지 않았다. quiet-r1은 발생기 놓침 87로 무효라 버렸다.
- **잡음 쌍**: 첫 잡음(purchase-svc 시험 반복)은 너무 무거워 대상이 무너져 버렸다. 두 번째 잡음(args090 시험 반복)은 r4가 놓침 14로 무효, r5만 유효(69.17ms)라 쌍을 이루지 못했다. `noise2`는 pnpm 실행 실패로 잡음이 없었고, 그 실행들(r2·r3)은 잡음 쌍으로 쓰지 않았다.
- **조용한 구간 오염 확인**: quiet-r2(16:43:13~16:50:57 KST)·quiet-r3(16:53:17~17:01:02 KST)는 purchase-svc 잡음 시작(17:01:20 KST) 전에 끝났다. quiet 구간에는 의도한 잡음이 없었다. quiet-r1도 잡음 전이다.
- A/A는 **성립하지 않았다**. K2 3회 유효(41.06·44.33·46.11ms)는 통과 후보지만, A/A 잡음 폭이 34%라 이 무대에서 50ms 목표의 작은 차이를 A/A로 가르기 어렵다. 다음 측정은 A/A 전에 조용한 조건의 반복 변동 원인(발생기 시작·호스트 부하)을 줄이는 방법을 먼저 정해야 한다.

## 7. 4관점 리뷰

- **정확성**: D는 `WARM_START_AT_MS`가 없으면 기존처럼 즉시 시작하고, K1·K7·v0 기본 예열은 30초 그대로다. A는 `http.auth`·`http.problem`이 `http.handler`의 부분 구간이고 `http.log`가 `http.serialize`·`http.total`의 부분 구간이라는 것을 문서에 적었다. B는 넘어온 세션에도 계정·회차·`maxStayUntilMs`를 다시 본다.
- **동시 실행**: `HotPathMetrics.start`는 요청마다 독립된 클로저를 쓰고, Node 단일 스레드에서 카운터·히스토그램 갱신이 원자적이다. 두 번 끝내도 한 번만 관측한다. `WARM_START_AT_MS`는 발생기마다 같은 절대 시각을 읽고, 준비가 늦은 발생기는 그 사실이 `startSkewS`로 드러난다.
- **장애**: B의 fallback(`session` 없음)은 기존 `sessions.get` 경로를 그대로 쓴다. 인증 읽기·`advance`·홀드 저장소 장애는 각각 기존 503 경로다. A의 지표는 던져도 요청을 막지 않는다(`#safe`/`try-finally`). K2에서 A 계측을 켠 p99가 41~46ms로 BAT-027(47.54ms)보다 낮아, 계측 오버헤드가 목표를 흔드는 수준은 아니었다.
- **보안**: 라벨은 `service`·`stage`·`outcome`뿐이고 계정·주문·회차·좌석 ID를 싣지 않는다. B의 인증 시점 스냅샷은 인증과 홀드 사이에 세션이 끝나는 좁은 구간을 놓친다. 다만 인증 훅의 `resolve`가 계정·로그인 세션·최대 체류를, `advance`가 세션 존재를 확인한 뒤이고, 홀드가 `maxStayUntilMs`를 다시 본다. **높음·보안 지적은 없고, 중간(알려진 동작 차이)** 으로 남긴다. 이 창을 더 좁히려면 세션 판 번호를 홀드 Lua까지 전달하는 별도 설계가 필요하다.
- **화면-서버 연결**: D·A·B는 HTTP 응답 본문·상태 코드·Problem type을 바꾸지 않는다. 409 경로의 `normalBranch`·`Retry-After`·`Cache-Control`도 그대로다. 화면이 보는 값은 바뀌지 않는다.

## 8. 게이트

- typecheck: `@peaket/platform`·`@peaket/purchase-svc`·`@peaket/payment-svc`·`@peaket/queue-svc` 통과.
- 시험: platform 509, purchase-svc 3,692, payment-svc 2,891, queue-svc 666 통과. `tools/local/cluster.test.mjs`·`v1-stage.test.mjs` 51 통과(3은 openssl PATH 없음으로 건너뜀), `loadtest/test/v1.test.mjs` 46 통과.
- 린트: `pnpm lint` 통과.
- doc-check: 오류 0(경고 4, 기존 openapi 3건·mermaid 환경 1건).
- trace-check: `S-T1` 9·`S-T35` 8·`P-T1` 6 통과(시험 238개 대조). `S-T2`는 측정 항목이라 자동 시험 대조에서 뺐다(장부에서 측정으로 분류).
- ledger: `node tools/ci/ledger.mjs --batch BAT-028 --require` 통과(범위 4항목, 빈칸 0). K7 3회는 `docs/perf-ledger/runs/2026-11-11-k7-v1-fault-r*-bat028`에 무효로 기록했다.
- 변이: A `http.problem` 이름 바꾸기, B 최대 체류 경계 제거, B 세션 재사용 끄기 모두 시험이 잡았다(`docs/review/measurements/BAT-028/mutation-check.md`).
- 표준 지연 칸: docs/observability.md §8의 22칸과 `LATENCY_BUCKETS_SECONDS`가 어긋나 있던 기존 불일치를 이번에 맞췄다(0.25·0.6 추가, 22칸). platform 시험도 22칸으로 고쳤다.
- 로컬 클러스터 이미지: `preloadLocalImages`(fix(local), R-474)로 새 kind 노드에 태그 이미지를 미리 싣고 `up`·`observability`·`v1`이 정상 기동하는 것을 확인했다. 이 수정은 BAT-028 코드·측정과 별도 커밋으로 둔다.

## 9. 기록과 다음

- 원자료: `docs/review/measurements/BAT-028/`의 K2 r1~r4, K7 `docs/perf-ledger/runs/2026-11-11-k7-v1-fault-r*-bat028/`, A/A `docs/review/measurements/BAT-028/aa/`(원자료는 `.cache/peaket-bat028/aa`), `mutation-check.md`.
- 계획: `docs/review/plans/BAT-028.md`.
- 다음: K7 ②는 결제 경로 처리량 때문에 3회 모두 무효·미달이므로 별도 결제 최적화 배치가 필요하다. A/A는 조용한 쌍의 변동(34%)이 커 성립하지 않았으므로, 발생기 시작·호스트 부하를 고정하는 측정 방법 배치를 먼저 둔다. K2 3회 유효·중앙값 44.33ms는 BAT-028의 D·A·B 성과로 남기고, K7·A/A는 후속 배치로 넘긴다.
