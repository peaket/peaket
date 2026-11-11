# BAT-031 K7 꼬리 진단·수정 결과

- 날짜: 2026-11-12
- 비교 기준: BAT-029 r3 유효 K7 — 결제 확정 p99 5,375.2ms, p95 3,714.0ms, 홀드 p99 226.0ms (`docs/perf-ledger/runs/2026-11-11-k7-v1-fault-r3-bat029`)
- 목표: 결제 확정 p99 3,000ms, 홀드 p99 50ms, 유효
- 결론: **목표 미달.** 40초 유효 실험에서 p99 4,694.8ms까지 내렸고 `RESERVED → CONFIRMED` p99는 2.86초까지 왔다. 100초 K7은 VU 고갈(놓침 495)로 무효다. 남은 병목은 코드 구간이 아니라 3복제×4 CPU 합본의 이벤트 루프 포화다.

## 1. 무대

| 항목 | 값 |
| --- | --- |
| 호스트 | Windows 11, Intel i9-14900HX 24코어/32스레드, Docker 32 CPU·16GiB |
| 클러스터 | kind `peaket` 단일 노드, v1 네임스페이스 |
| 합본 | 복제 3 고정, CPU 요청=한도 4, 메모리 512Mi(기준)·1Gi(실험), HPA 끔 |
| PostgreSQL | v1 전용, `max_connections 600`, 메모리 요청 1Gi·한도 2Gi |
| 부하 | v1 payment, 100/s, 좌석 2, 응답 버림 5%·16,000ms 지연 0.5% |
| 판정 | k6 놓침 0·시나리오 오류 0·`startSkewS=0`이어야 유효 |

## 2. 실행 표

40초 실험은 코드 수정을 하나씩 누적하며 원인을 가르기 위한 것이다. 100초 진단은 목표 판정용이 아니다.

| 실행 | 길이 | 코드/무대 | 결제 확정 p99 | p95 | 홀드 p99 | 주문 실패 | 판정 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BAT-029 r3 | 100s | BAT-029, 512Mi, CPU 4, 새 클러스터 | 5,375.2ms | 3,714.0ms | 226.0ms | 14.7% | 유효·목표 미달 |
| BAT-031 진단 r3 | 100s | BAT-029 코드, 512Mi | 12,485.2ms | 11,122.6ms(상태) | 295.2ms | 24.6% | **무효**(놓침 88) |
| exp-mem1024 | 40s | BAT-029 코드, 1Gi·semi64 | 13,257.0ms | 6,855.0ms | 297.6ms | 11.2% | 유효 |
| exp-code1 | 40s | UNKNOWN 250 + 소비자 48 + 핫풀 16 + HMAC + 임대 해제 | 6,496.0ms | 3,104.7ms | 238.3ms | 12.4% | 유효 |
| exp-code2 | 40s | + Saga 데드라인 2,000ms | 9,658.0ms | 3,948.0ms | 249.1ms | 8.4% | 유효 |
| exp-code3 | 40s | + Saga 데드라인 1,000ms | 5,206.4ms | 2,841.1ms | 320.8ms | 9.3% | 유효 |
| exp-code4 | 40s | + 승인 실행기 DB 풀 24 | **4,694.8ms** | **2,797.1ms** | 259.6ms | 8.6% | 유효 |
| K7 100s 진단 | 100s | exp-code4와 같은 코드 | 14,054.0ms | 11,288.3ms | 227.7ms | 11.8% | **무효**(놓침 495, VU 1,648) |

- 40초 실험의 결제 확정 p99는 4.7초까지 내려왔지만 100초로 늘리면 무너진다. 100초 진단은 `dropped_iterations 495`로 VU 풀이 고갈됐고, 이 값은 K7 판정에 쓸 수 없다.
- 홀드 p99는 227.7~320.8ms로 목표 50ms와 거리가 멀다. 40초 실험에서도 238~321ms다.
- 주문 실패 8.4~24.6%는 핫패스 풀 대기 100ms가 429 `server-busy`로 바뀐 것이다. 핫풀 16/32를 모두 재 봤지만 429가 p99의 주원인은 아니었다.

## 3. 가장 좋은 40초 실행의 분해(exp-code4)

DB 시각으로 주문 전이를 쪼갠 값이다(집계 n=3,245).

| 구간 | p50 | p95 | p99 | p99.5 |
| --- | --- | --- | --- | --- |
| Saga `RESERVED → payment.created` | 70ms | 177ms | 222ms | 251ms |
| 결제 `payment.created → approved` | 476ms | 1,118ms | 1,995ms | 3,774ms |
| 결과 소비자 `payment.approved → order.APPROVED` | 882ms | 1,616ms | 2,604ms | 4,261ms |
| 발권·확정 `order.APPROVED → CONFIRMED` | 259ms | 689ms | 785ms | 823ms |
| 주문 전체 `RESERVED → CONFIRMED` | 1,201ms | 1,959ms | **2,860ms** | 4,469ms |

- 3,245건 중 32건(0.99%)이 3초를 넘고, 16건(0.49%)은 16초 지연 주입분이다. 즉 **p99 3초 경계에 걸쳐 있다**. K7 `payment_confirm_ms` p99 4.7초는 접수 요청·상태 롱 폴링·이벤트 루프 대기까지 더한 값이다.
- 결과 소비자는 48키·48연결로 올린 뒤 outbox→Kafka→order APPROVED 지연이 p99 0.83초(max 1.29초)로 내려왔다. 더 이상 소비자 풀 적체가 아니다.
- 승인 실행기 풀 24로 `payment.confirm.read/mark/finish` 대기가 줄어 결제 확정 p99가 5,206→4,695ms로 내려왔다.
- Saga 데드라인은 500ms일 때 `RESERVED → payment.created` p99 4.2초, 1,000ms일 때 0.24초, 2,000ms일 때 6.9초였다. 1,000ms가 가장 좋다.

## 4. 이벤트 루프 포화

| 지표 | 값 |
| --- | --- |
| `nodejs_eventloop_utilization` p50·p99 | 1.0 |
| 프로세스 CPU | 파드당 약 1.13코어(한도 4) |
| 요청당 CPU | 약 6.2ms(40초 실험 22,000요청·137 CPU초) |
| GC | 1Gi·semi64에서 5.2초/100초(512Mi에서 21.8초/100초) |
| PG 연결 최대 | 391(한도 600) |

- 프로파일 상위: GC 14%(512Mi), pg 질의 쓰기 `writev` 8%, drizzle 질의 구성 4%, pg 결과 파싱 3%, 로그 가명 HMAC 2%, Fastify/HTTP 5%, OTel/prom-client 3%.
- 1Gi·semi64로 GC를 4분의 1로 줄여도 이벤트 루프 사용률은 1.0이었다. CPU 한도 4 중 3개는 Node 이벤트 루프 하나가 쓰지 못한다.
- 100초 동안 100/s를 유지하려면 초당 처리량이 더 필요하다. 3복제 고정을 지키는 한, 요청당 트랜잭션/CPU를 절반 가까이 줄이거나 합본을 여러 실행 단위로 나눠야 한다.

## 5. 수정 목록

- `UNKNOWN_QUERY_BASE_MS` 250ms, `UNKNOWN_QUERY_POLL_INTERVAL_MS` 250ms, 지수 상한 8.
- Saga `CONFIRM_CALL_DEADLINE_MS`·`CONFIRM_CAP_MS` 1,000ms.
- 결제 결과 소비자 `PAYMENT_CONSUMER_DB_MAX` 48, `maxKeys: 48`.
- 승인 실행기 `CONFIRM_RUNNER_DB_MAX` 24.
- 승인 `finish` 최종 실패 시 `releaseLease`(75초 임대 시간만 당김).
- 로그 가명 HMAC `KeyObject` 재사용.
- purchase 핫패스 풀 32→16 되돌림.
- 측정 도구: `cluster.mjs v1 --cpus/--memory-mi`, `run.mjs --target-cpus` 검사·`infra.txt` 목표 기록.

## 6. 재현 명령

```powershell
# 새 무대(회마다)
node tools/local/cluster.mjs down
node tools/local/cluster.mjs up
node tools/local/cluster.mjs observability
node tools/local/cluster.mjs v1 --cpus 4 --memory-mi 1024
$env:KUBECONFIG='D:\ticketpass-lane1\.cache\peaket-tools\kubeconfig-peaket'
kubectl -n v1 set env deploy/bundle NODE_OPTIONS="--max-semi-space-size=64"

# 40초 실험
node loadtest/run.mjs v1 payment --users 4202 --rate 100 --seats-per-order 2 `
  --warm 2 --main 40 --fault-drop-pct 5 --fault-delay-pct 0.5 `
  --target-cpus 4 --out .cache/peaket-bat031/exp-code4

# 100초 진단(무효: 놓침 495)
node loadtest/run.mjs v1 payment --users 11002 --rate 100 --seats-per-order 2 `
  --warm 10 --main 100 --fault-drop-pct 5 --fault-delay-pct 0.5 `
  --target-cpus 4 --out .cache/peaket-bat031/k7-formal-diag-r1
```

## 7. 남은 문제

1. **이벤트 루프 격리**: 3복제×4 CPU에서 한 프로세스가 한 코어만 쓴다. 워커/클러스터 분리 또는 요청당 트랜잭션 축소가 필요하다.
2. **홀드 50ms**: K7 혼합 부하에서 결제·소비자와 같은 이벤트 루프를 쓰는 한 227~321ms다. 홀드 경로 분리가 필요하다.
3. **100초 유효성**: 100/s를 100초 유지하지 못해 VU가 고갈된다. 40초 실험만으로 3초 목표를 판정할 수 없다.
4. **A등급 마무리**: K7 3회·A/A·K2 3회, 변이·복구 장애·trace-check·test-int·4관점 리뷰는 BAT-032에서 새 무대로 다시 한다.
