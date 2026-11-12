# BAT-039 결과 — UNKNOWN 조회 꼬리 단축

- 날짜: 2026-11-13
- 묶음: BAT-039(HOT-473, 갈래 1, A등급, 0.5~1일 [가정])
- 장부 범위: `P-T1`, `P-T23`
- 선행: BAT-038(HOT-472, R-509). K7 r1 접수 429 0.75% <1% 통과, `payment_confirm_ms` p99 3,609.8ms 미달.

## 1. 느린 결제 1% 분해

`records.ndjson`의 `pg_charge` 10,153건, 주문 ID(UUIDv7) 시각 → 결제 승인 시각:

| 백분위 | 값 |
| --- | ---: |
| p50 | 1,425ms |
| p90 | 2,438ms |
| p95 | 2,753ms |
| **p99** | **3,976ms** |
| p99.5 | 10,800ms |
| p99.9 | 17,912ms |
| max | 18,664ms |

- 10~20초: **53건(0.52%)** = 16초 지연 0.5% 군. p99.5~p100에 있다.
- 3~5초: 248건(2.44%), 5~10초: 19건, 3초 이상 합계 320건(3.15%).
- 느린 1%(102건) = 16초 지연 53건 + 정상/드롭 49건. **p99 3.976초는 16초 지연군이 아니라 3~5초의 느린 꼬리**가 만든다.
- `sim_fault` 516건(5.55%) = 드롭 5%(~463) + 지연 0.5%(53). p99 경계의 49건은 드롭 쪽이 유력하지만, K7 산출물에 시뮬레이터 장애 로그가 없어 드롭/정상을 결제별로 확정하지 못했다.

## 2. 대기·재시도

| 지표 | p50 | p99 |
| --- | ---: | ---: |
| `payment.status.wait` | 1.319s | **3.825s** |
| `payment.status.read` | 21.9ms | **240.3ms** |
| `payment.status.poll` | 13.2ms | 71.3ms |
| `saga.total` | 266.9ms | 797.6ms |
| `payment.result.total` | 217.2ms | 490.0ms |
| `hold.total` | 3.0ms | 18.3ms |

- 느린 `payment-status` 200 표본: 17.6~19.2초 3건(지연군), 4.9·4.07·3.47·3.27·3.01초, 그 아래 매끄러운 2.9초 꼬리.
- `payment.status.wait` p99 3.825s가 confirm p99 3.61s의 대부분이다. wait table `poll` p99 71ms, `read` 핫풀 240ms는 작은 몫이다.
- 번들 CPU 0.98코어, 이벤트 루프 p99 12.6ms·max 29.9ms로 CPU/event loop 병목이 아니다.
- 드롭 5%는 UNKNOWN이 되고, 기존 조회 간격 250ms×2배의 누적 250+500+1,000+2,000=3.75초가 p99 3.6초 꼬리와 맞는다.

### 0.5% 16초 지연의 구조적 영향

- 0.52%라 **p99 경계를 직접 만들지 않는다.** p99.5 이상을 10~19초로 끌어올린다.
- 따라서 `payment_confirm_ms` p99 <3초는 0.5% 지연 때문에 구조적으로 불가능하지 않다.
- 공식 `payment_p99_3000ms` **≤1%** 점검은 0.5% 지연군만으로 0.5% 초과가 잡혀 다른 느린·비끝 답에 0.5% 여유밖에 없다. 공식 점검을 목표로 삼으면 목표·장애 주입 조정이 필요할 수 있다.

## 3. 고른 수정 — (가) UNKNOWN 조회 백오프·주기 단축

- `UNKNOWN_QUERY_BASE_MS` 250 → **100ms**
- `UNKNOWN_QUERY_POLL_INTERVAL_MS` 250 → **100ms**
- `DELAY_EXPONENT_CAP` 8 → **10**(기준 100ms에서도 상한 60초)
- 입금 통보 경로의 5초 기준·2배는 유지한다.
- 드롭 5%의 UNKNOWN 첫 조회·재조회가 빨라져 3.75초까지 쌓이던 꼬리를 줄인다. 16초 지연군은 p99.5에 남는다.
- (나) wait table wake는 `poll` p99 71ms, (다) `payment-status` 읽기 풀은 `read` p99 240ms로 작다. (라) 정상 쓰기 경로는 `saga.total` 798ms·`payment.result` 490ms로 1초 안이다. p99 경계의 주원인은 UNKNOWN 조회 꼬리로 본다.

## 4. 시험·싼 게이트

- payment-svc 단위 전체 **34파일 2,904건 통과**.
- 관련 test-int **95건 통과**: `payment-unknown-resolver`·`payment-call-guard`·`payment-deposit`.
- typecheck: `@peaket/payment-svc` 통과. lint: 오류 0.
- doc-check·ledger·records·trace-check는 커밋 전에 확인한다.

## 5. 다음

- K7 진단 1회(measurement go 뒤, 같은 조건, BAT-038 기본 64 유지)에서 `payment_confirm_ms` p99 <3초를 확인한다.
- 접수 429 <1%도 함께 확인한다.
- p99가 아직 3초를 넘으면 정상 쓰기 경로/전용 풀, wait table, `payment-status` 읽기 풀 순으로 다음 후보를 고른다.
- 0.5% 16초 지연은 p99.5에 남는다. 공식 ≤1% 점검을 목표로 삼으면 목표·장애 주입 조정 필요성을 소유자와 정한다.
