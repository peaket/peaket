# BAT-034 결과 — purchase-svc 핫패스 DB 풀 대기(429 server-busy)

- 날짜: 2026-11-12
- 묶음: BAT-034(HOT-468, 갈래 1, A등급, 0.5~1일 [가정])
- 장부 범위: `P-T1`, `P-T23`
- 선행: BAT-033 K7 진단(2026-11-12, `.cache/peaket-bat033/k7-diag-r1/`)

## 1. 진단 증거

K7 진단 1회(공식 유효 조건은 dropped 170·시나리오 오류 59로 미달, 진단용):

| 항목 | 값 |
| --- | ---: |
| 본구간 접수 호출 | 6,557 |
| 202 | 5,759 (87.83%) |
| **429 `server-busy`** | **794 (12.11%)** |
| 503 `seat-store-unavailable` | 4 (0.06%) |
| 409·422·500·504 | 0 |
| `over_target` | 1,374 (20.95%) |
| `payment_end_truncated` | 746 (terminal/pending 합계) |
| `payment_outcomes` PENDING | 258 |
| `payment_confirm_ms` p99 | 6,236.3ms |

- 같은 429가 `/v1/orders` 2,545건, `/v1/orders/{orderId}/payments` 1,296건에도 났다(3개 bundle 파드 로그, 예열 포함).
- 429의 `err.type`은 전부 `server-busy`였다.
- 429 `durationMs`: 접수 p50 228ms·p90 368ms·p99 535ms, 주문 p50 259ms·p90 428ms, 결제 시작 p50 248ms·p90 514ms.
- 성공 201/202 `durationMs`: p50 524~563ms·p90 757~793ms. 429는 성공보다 **빠르게 실패**한다. 풀 대기 100ms에서 끊긴 것이다.
- 진단 뒤 PostgreSQL: `max_connections` 600, `pg_stat_activity` idle 36·active 0, `purchase-svc` 핫패스 연결 0(10초 idle 뒤 닫힘), deadlock 0, disk read 47 vs cache hit 6.3M. DB I/O·연결 여유는 있었다.

### 작은 통합 시험(실제 PostgreSQL, max 1 풀)

200ms 동안 연결 하나를 점유하고 두 번째 질의가 기다리게 했다.

| 설정 | 결과 | 걸린 시간 |
| --- | --- | ---: |
| max 1, 대기 100ms | `timeout exceeded when trying to connect` → 429 | 108ms |
| max 1, 대기 250ms | 성공 | 206ms |
| max 1, 대기 500ms | 성공 | 205ms |
| max 2, 대기 100ms | 성공 | 7ms |

## 2. 고른 수정

**(나) purchase-svc 핫패스 연결 대기 100ms→250ms.** 풀 max는 16 유지.

- `PEAKET_DB_HOT_CONNECT_TIMEOUT_MS` 기본 250ms(`services/purchase-svc/src/db-pool.ts`).
- `packages/platform/src/database.ts`의 `DatabaseOptions.connectionTimeoutMillis`로 서비스가 profile 기본값을 덮는다.
- `services/purchase-svc/src/start.ts`가 핫패스 풀에 이 값을 넘긴다.
- `docs/architecture.md`의 앱 연결 풀 표에 구매-svc 예외·이유를 적었다.

왜 (가) max 16→32가 아닌가:

- BAT-031이 핫풀 16/32를 모두 재 봤고, 32는 429를 줄이지 못한 채 이벤트 루프·PostgreSQL 연결 압박만 키워 16으로 되돌렸다.
- 이번 진단도 DB 여유는 있었지만, 429의 직접 원인은 100ms 대기 한도였다. 250ms는 200ms 점유를 실제 PostgreSQL에서 흡수했다.

왜 (다) 트랜잭션 축소가 아닌가:

- 세 경로의 트랜잭션은 이미 짧은 DB 문장으로 되어 있고, 429는 그 전에 100ms 대기에서 끝난다. 트랜잭션 축소는 이번 증거의 직접 원인보다 큰 변경이다. 250ms로 부족하면 다음 배치에서 검토한다.

왜 (라) HTTP 백프레셔가 아닌가:

- 풀 대기 초과가 이미 입구 백프레셔 역할을 한다. 먼저 대기 한도를 늘려 짧은 포화를 흡수하고, 그래도 429가 남으면 입구 상한을 검토한다.

K7 p99 3초 영향:

- 성공 요청 p50 524ms에 최대 150ms를 더해도 3초와 거리가 멀다. 429로 실패하던 요청이 202로 바뀌는 쪽이 낫다.
- 429 p90 368ms는 250ms 대기로 흡수되고, p99 535ms의 꼬리는 다음 진단에서 확인한다.

## 3. 시험

- `packages/platform/test/database.test.ts`: 5건 통과. 사용자 지정 250ms가 실제로 적용되고 429 `server-busy`로 끝나는지, 잘못된 값이 시작을 막는지.
- `services/purchase-svc/test/db-pool-config.test.ts`: 3건 통과. 기본 250ms·1~5,000 정수·범위 밖 거부.
- `services/purchase-svc/test-int/database-pool.int.test.ts`: 2건 통과. 실제 PostgreSQL max 1에서 100ms는 429, 250ms는 200ms 점유를 흡수.
- 주문·결제 시작·접수 단위 시험 6파일: 417건 통과.
- 주문 저장소·쓰기 test-int 2파일: 223건 통과(실제 PostgreSQL, Redis 없음).
- `accept-e2e`·`orders-e2e` 전체는 이번에 돌렸을 때 30/59 실패했다. 실패는 `RedisDeadlineError`(좌석 Redis 100ms 마감) → 503 `seat-store-unavailable`이고, DB 대기 변경과 무관한 실패다. 갈래 2 heavy gate와 겹친 환경 영향으로 보이며, 통과로 세지 않고 lane 2가 끝난 뒤 다시 돌린다.

## 4. 다음

- K7 진단은 아직 돌리지 않는다. 갈래 2 heavy gate가 끝나고 `measurement go`를 받은 뒤 수정 후 K7 진단 1회에서 접수 429 <1%와 p99를 확인한다.
- 진단에서 `payment_accept_status{phase:main,status}`·`payment_end_truncated_terminal`·`payment_end_truncated_pending`을 함께 본다.
- 429가 1% 이상 남으면 (다) 트랜잭션 축소 또는 (라) HTTP 백프레셔를 다음 배치로 검토한다.
