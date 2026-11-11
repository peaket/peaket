# BAT-027 핫패스 구간 계측

- 날짜: 2026-11-11
- 대상: BAT-026이 남긴 K2 2,000/s p99 53.6ms(목표 50ms)와 웜 구간 놓침 12건. v1 합본(purchase-svc·payment-svc·queue-svc·admission-ctrl) CPU 4/replica.
- 결론: **계측 실행의 p99는 47.54ms로 목표 안이었지만, 발생기 웜 구간 놓침 143건으로 실행이 무효라 정본 통과로 세지 않는다.** 안쪽 `HoldSeats.execute` p99는 22.6ms이고, HTTP 서버 p99 48.18ms와의 차이 25.58ms가 가장 큰 단일 몫이다. 안쪽에서는 `hold.session`(평균 2.36ms, 47.6%)과 `hold.lua`(2.04ms, 41.1%)가 대부분이고 DB 기록(`hold.attempts`)은 0.003ms로 무시할 수 있다. 웜 구간 놓침은 발생기 2·3대의 시작 구간에만 있고 본구간은 0이며, 발생기 CPU 28.3%·오류 0이라 대상 p99의 원인이 아니다.

## 1. 계측 범위와 설계

- 공용 `packages/platform/src/hot-path.ts`의 `HotPathMetrics`가 두 지표를 낸다.
  - `hot_path_stage_seconds{service, stage}`: 구간 시간 히스토그램(표준 지연 칸).
  - `hot_path_outcomes_total{service, outcome}`: 요청 하나의 최종 결과 카운터.
- 이름표는 `service`·`stage`·`outcome`의 고정 목록뿐이다. 계정·주문·좌석·회차 ID는 싣지 않는다(docs/observability.md §8).
- 계측은 동작을 바꾸지 않는다. 구간 시간은 주입 Clock이 아니라 `process.hrtime` 단조 시계로 재고, 지표가 던져도 요청을 막지 않는다. `HotPathMetrics`를 넘기지 않으면 원래 함수만 부른다.
- 구간:
  - purchase-svc `HoldSeats`: `hold.session`, `hold.seat_config`, `hold.seat_resolve`, `hold.replay`, `hold.lua`, `hold.attempts`, `hold.session_record`, `hold.total`.
  - purchase-svc `GetPaymentStatus`: `payment.status.read`, `payment.status.deposit_read`, `payment.status.wait`, `payment.status.total`.
  - payment-svc `PaymentConfirmRunner`: `payment.confirm.claim`, `read`, `mark`, `gateway`, `finish`, `reschedule`, `drop`, `release`.
  - queue-svc `EnterQueue`: `queue.entry.schedule`, `preempt`, `arrival`, `number`, `batch_record`, `record`, `batch_result`, `mirror`, `release`, `total`.
- 합본은 서비스마다 논리 이름(`purchase-svc`·`payment-svc`·`queue-svc`)을 `service` 라벨로 두어 관리 포트에서 합쳐도 구분된다. 실제 `/metrics`에서 세 이름이 모두 보이는 것을 확인했다.
- 계측 지표 정의와 고정 목록은 docs/observability.md §3에 적었다.

## 2. 단위 시험과 변이

- 새 시험:
  - `packages/platform/test/hot-path.test.ts` — 두 지표의 이름·라벨·관측, 두 번 붙이기, 성공·실패 모두 관측, 계측을 넘기지 않을 때 원래 함수만 부르기.
  - purchase-svc `test/hold-seats.test.ts` — 성공 1건과 409 경합 1건의 outcome, `hold.total`·`hold.lua`·`hold.session` 관측, 계정·회차·좌석 ID가 라벨에 없음.
  - purchase-svc `test/get-payment-status.test.ts` — 기다린 요청의 `payment.status.read`·`wait`·`total`, `ok` outcome.
  - payment-svc `test/payment-confirm-runner.test.ts` — 승인 1건의 `read`·`mark`·`gateway`·`finish`, `approved` outcome.
  - queue-svc `test/enter-queue-hot-path.test.ts` — 진입 성공과 `ALREADY_WAITING` 거절의 outcome, `preempt`·`number`·`record`·`total` 관측.
- 작은 틀린 구현 검사(자세한 것은 `docs/review/measurements/BAT-027/mutation-check.md`):
  - HoldSeats catch의 `hotPath.outcome(holdOutcomeOf(err))` 한 줄을 빼자 409 outcome 시험이 **실패**했다. 되돌리니 통과했다.
  - `payment.status.read` 구간 이름을 `payment.status.total`로 바꾸자 read 구간 시험이 **실패**했다(총 관측 수 3, read 없음). 되돌리니 통과했다.
- 전체 시험: purchase-svc 3,687건, payment-svc 2,891건, queue-svc 666건 통과. platform은 508건 가운데 507건 통과였고, 실패 1건은 이 묶음과 무관한 기존 문서·코드 불일치다(§6).

## 3. K2 2,000/s CPU 4/replica 결과

- 같은 클러스터, 같은 방법: v1 합본 3복제, CPU request/limit 4, 메모리 512Mi, Redis TLS 켬, 인기 좌석 1개, 사용자 1,000명, 2,000/s, `--keep`, 예열 30초·본구간 60초, 발생기 4대.
- `docker ps`에 시험 컨테이너가 없음을 확인했고, 끝난 뒤 발생기 파드를 정리하고 합본 CPU를 1/replica로 되돌렸다.
- 실행: `2026-11-11T11:47:27+09:00` ~ `2026-11-11T11:51:47+09:00`. 본구간 지표 창은 `11:48:30` ~ `11:49:30`(+09:00)이다.
- 원자료: `docs/review/measurements/BAT-027/k2-2k-cpu4.summary.json`·`.generator.json`·`.run.json`·`.infra.txt`·`.crictl.txt`·`.stage-metrics.json`·`.metrics.json`.

| 항목 | 값 | 목표 | 판정 |
| --- | --- | --- | --- |
| 홀드 p99 | **47.54ms** | ≤50ms | 목표 안 |
| 홀드 p99.9 | **81.36ms** | ≤150ms | 통과 |
| 홀드 201 | **1건**(DB `seat_hold` 1행) | 1건 | 통과. 본구간에는 2xx가 0이고 201은 예열 구간에 났다 |
| 오류 | **0** | 0 | 통과 |
| 발생기 놓침 | **143**(웜 구간 59+84, 본구간 0) | 0 | **무효** |
| 발생기 CPU·메모리 | 28.3%·28.9% | 80%·90% 아래 | 통과 |
| 합본 app CPU | **3.07코어**(Prometheus, 12코어의 25.6%), crictl 최대 336.83% | 포화 아님 | 여유 |
| 합본 event loop lag p99 | 최대 **19.56ms**(파드별 19.56·16.21·18.12), 최대값 33.65ms | — | 여유 |
| PG 연결 | 최대 **41/600** | — | 여유 |
| Valkey CPU | 최대 29.75% | — | 여유 |
| PostgreSQL CPU | 최대 19.18% | — | 여유 |
| Kafka CPU | 최대 4.81% | — | 여유 |
| nginx CPU | 최대 0.12% | — | 여유 |
| relay CPU | 최대 10.86% | — | 여유 |

- **정본 통과는 아니다**: p99는 목표 안이지만 웜 구간 놓침 143건으로 발생기 판정이 무효다. BAT-026과 같은 규칙으로 무효를 통과로 세지 않는다.
- BAT-026 CPU 4 실행(53.6ms)보다 p99가 6.1ms 낮아졌다. 계측은 관측만 더하므로 이 차이를 계측 효과로 볼 수 없다. 같은 조건의 실행 사이 변동으로 적고, 기준선 53.6ms를 계측 실행으로 다시 설명하지는 않는다.
- 웜 구간 놓침은 발생기 2·3대에만 있고(59·84), 4대 모두 본구간 놓침은 0이다. 발생기 CPU 28.3%·메모리 28.9%·시나리오 오류 0이라 대상 서비스의 p99 원인이 아니라 발생기 시작 구간의 문제로 본다.

## 4. 상위 기여 구간

본구간 119,922건은 모두 409 경합이고(2xx 0), `http_server_business_rejections_total`도 119,922건이다. 안쪽 `HoldSeats.execute`와 HTTP 전체를 견준 표다. 평균은 구간 합÷관측 수, p99는 표준 히스토그램에서 계산했다.

| 구간 | 평균 | p99 | 50ms 초과 | 안쪽 평균 비중 |
| --- | --- | --- | --- | --- |
| `hold.total`(execute 전체) | **4.956ms** | **22.60ms** | 40건(0.034%) | 100% |
| `hold.session`(구매 세션 Redis 읽기) | **2.357ms** | **11.42ms** | 0 | **47.6%** |
| `hold.lua`(좌석 홀드 Lua) | **2.037ms** | **9.76ms** | 0 | **41.1%** |
| `hold.seat_config`(좌석맵 판) | 0.043ms | 5ms 미만(첫 칸) | 0 | 0.9% |
| `hold.seat_resolve`(좌석 ID 확인) | 0.038ms | 5ms 미만(첫 칸) | 0 | 0.8% |
| `hold.attempts`(시도 기록) | **0.0027ms** | 5ms 미만(첫 칸) | 0 | 0.05% |
| `hold.session_record` | — | — | — | 409 경로는 부르지 않음 |
| HTTP 서버 전체 | **10.555ms** | **48.18ms** | 371건(0.31%) | — |
| HTTP − execute 차이 | **5.599ms** | **25.58ms**(p99 차이) | — | — |

- **가장 큰 단일 몫은 execute 밖이다.** HTTP p99 48.18ms와 `hold.total` p99 22.60ms의 차이 25.58ms다. 평균으로도 10.56ms 가운데 5.60ms(53%)가 execute 밖이다. 인증·본문 검사·409 문제 변환·정규 로그·응답 직렬화·이벤트 루프 대기가 여기에 있다. event loop lag p99가 파드별 16.21~19.56ms까지 올라간 것이 이 차이의 큰 부분으로 보인다. 다만 이번 계측은 execute 안만 나눴으므로 그 안에서 어디가 큰지는 아직 모른다.
- **안쪽은 두 구간이 거의 전부다.** `hold.session`과 `hold.lua`가 평균의 88.7%다. `hold.session`은 모든 요청이 구매 세션을 Redis에서 한 번 더 읽는 구간이고, `hold.lua`는 경합 확인을 포함한 좌석 Lua 한 번이다. `hold.seat_config`·`hold.seat_resolve`는 0.04ms 수준이고, 시도 기록은 0.003ms다.
- **DB 시간은 홀드 경로에 없다.** 운영 조립의 `HOLD_ATTEMPTS`는 `discardHoldAttempts`(받은 기록을 버림)라 `hold.attempts`가 사실상 0이다. purchase DB를 쓰는 `payment.status.read`는 이번 K2에 결제 트래픽이 없어 관측되지 않았고, 단위 시험으로 기록만 확인했다.
- **다른 서비스 구간도 이번 K2에는 부하가 없다.** payment-svc `payment.confirm.claim`은 100ms 틱 때문에 초당 65.6건 관측됐고(승인 행은 0), queue-svc 진입 구간은 0건이다. 이 두 경로의 계측은 단위 시험으로 확인했다.
- **표준 히스토그램 칸의 한계**: 5ms 미만 구간의 p99는 첫 칸(0~5ms) 안이라 `histogram_quantile`이 4.95ms로 보수적으로 계산된다. `hold.seat_config`·`hold.seat_resolve`·`hold.attempts`의 p99는 실제보다 크게 보이며, 평균과 `50ms 초과 0`을 더 믿어야 한다.
- **웜 구간 놓침 143건**: 본구간 0, 발생기 2·3대의 예열 구간에만 있다. 발생기 CPU·메모리·시나리오 오류가 정상 범위이고 대상 5xx도 0이라, 대상 p99가 아니라 발생기 시작(가상 사용자 1,000명을 한꺼번에 켜는 구간) 문제로 본다. 이 실행은 그 사실 때문에 무효다.

## 5. 다음 최적화 배치 제안

동작 최적화는 이번 묶음에서 하지 않았다. 아래는 다음 배치 후보와 예상 이득·비용이다.

| 후보 | 무엇을 | 예상 이득 | 비용·위험 |
| --- | --- | --- | --- |
| A. HTTP 입구·출구 계측 | 인증 가드·구매 요청 서명 확인·본문 검사·409 문제 변환·정규 로그·응답 직렬화·이벤트 루프 대기를 `http.entry.*` 같은 구간으로 나눈다 | HTTP p99와 execute p99의 차이 25.58ms 가운데 어디가 큰지 가른다. 계측만이라 동작 이득은 없지만 다음 수정의 표적을 정한다 | 0.5일, 낮음(관측만) |
| B. 구매 세션 중복 읽기 제거 | 인증 훅이 이미 읽은 구매 세션을 `HoldSeats`에 넘겨 `hold.session` Redis GET을 한 번 줄인다. 같은 파드·같은 요청 안에서 같은 세션을 두 번 읽는 것을 없앤다 | 안쪽 평균 2.36ms(47.6%)·p99 11.42ms를 줄일 수 있다. 세션 일관성(훅과 홀드 사이 변경)을 어떻게 다룰지에 따라 이득이 달라진다 | 1일, 중간. 인증 훅의 세션 판정과 홀드의 세션 판정이 같아야 한다 |
| C. 409 경합 빠른 길 | 좌석 Lua가 경합을 더 앞에서 가를 수 있는지 본다. 지금은 epoch·quota·좌석 검사 뒤 경합을 확인한다 | `hold.lua` 평균 2.04ms(41.1%)·p99 9.76ms의 일부. 경합 확인을 앞으로 옮길 수 있으면 409가 많은 K2에서 이득이 크다 | 1일, 높음. Lua 원자성·오류 차례·기존 시험을 다시 봐야 한다. 먼저 Lua 실행 시간을 프로파일한다 |
| D. 측정 방법 | 예열 60초 또는 가상 사용자 사전 시작·발생기 6대로 웜 구간 놓침을 없앤다 | 실행을 유효하게 만든다. 대상 p99 이득은 없다 | 0.5일, 낮음. 정본 목표(2,000/s·50ms)는 바꾸지 않는다 |

- 권장 순서: **A → B → D**를 먼저, C는 Lua 프로파일 뒤에. A로 execute 밖 25.58ms를 가르지 않으면 B·C를 해도 HTTP p99가 목표 안에 남을지 판단하기 어렵다.
- A의 예상 이득은 "줄이는" 이득이 아니라 "가르는" 이득이다. B·C의 예상 이득은 안쪽 평균 기준이며, HTTP p99 전체에 그대로 더해지지 않는다.

## 6. 게이트와 기록

- 타입 검사: `@peaket/platform`, `@peaket/purchase-svc`, `@peaket/payment-svc`, `@peaket/queue-svc` 모두 통과.
- 시험: purchase-svc 3,687건, payment-svc 2,891건, queue-svc 666건 통과. platform 508건 가운데 507건 통과.
  - platform의 실패 1건은 `test/metrics.test.ts`의 `ADR0077_표준칸20개는_observability_8의목록과같다`다. docs/observability.md §8은 0.25·0.6을 포함한 22칸인데 `LATENCY_BUCKETS_SECONDS`는 20칸이라 생기는 **기존 불일치**다. 이 묶음은 그 목록을 바꾸지 않았고, 측정 비교를 위해 지금 고치지 않았다. 별도 정합 배치가 필요하다.
- 변이 검사: 위 §2의 두 변이를 시험이 잡았고, 되돌린 뒤 다시 통과했다.
- K2: p99 47.54ms·p99.9 81.36ms·201 1건·오류 0이지만 웜 구간 놓침 143건으로 **무효(정본 통과 아님)**.
- 기록: BUILD_ORDER BAT-027·HOT-462, PROGRESS 진행 로그·다음 할 일, 계획 `docs/review/plans/BAT-027.md`, 이 보고서, `docs/review/measurements/BAT-027/`.

## 7. 남은 문제

- K2 실행이 웜 구간 놓침으로 무효라 p99 47.54ms를 정본 통과로 쓸 수 없다. 다음 측정은 예열을 늘리거나 발생기를 미리 켜 유효한 실행을 만들어야 한다.
- HTTP p99와 execute p99의 25.58ms 차이를 아직 구간별로 가르지 못했다. 인증·로그·응답 직렬화·이벤트 루프 대기 가운데 어디가 큰지는 다음 계측 배치가 답해야 한다.
- 표준 히스토그램 칸이 5ms 미만 구간을 정밀하게 가르지 못한다. 필요하면 진단용으로 더 촘촘한 칸을 두는 안을 소유자와 정한다(지금은 표준 칸을 그대로 쓴다).
- `docs/observability.md` §8의 22칸과 `LATENCY_BUCKETS_SECONDS`의 20칸 불일치는 이 묶음과 무관하게 남아 있다. 별도 정합 배치에서 코드·Envoy·경보 시험을 함께 맞춰야 한다.
