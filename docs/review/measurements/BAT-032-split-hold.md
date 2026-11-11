# BAT-032 트랜잭션 축소·홀드 분리 결과 (부분 완료·중단)

- 날짜: 2026-11-12
- 결정: 소유자 지시로 추가 K7/A/A/K2 측정을 중단하고, 현재 작업 트리를 부분 결과로 커밋한다.
- 목표: K7 결제 확정 p99 3,000ms·홀드 p99 50ms·유효. **결제는 3,039.9ms로 40ms 초과, 홀드는 k6 243.9ms/서버 43.4ms로 미달.**
- 이번에 한 것: 트랜잭션 축소(승인 read 병합), 합본 프로세스 분리(split), 홀드 전용 자식 프로세스, 측정 도구의 HOLD_BASE·모드 기록.
- 이번에 하지 않은 것: K7 ② 3회, A/A 쌍, K2 3회, 변이·복구 장애 주입·trace-check·test-int·4관점 리뷰. 다음 배치 OPEN[38]로 넘긴다.

## 1. 무대

| 항목 | 값 |
| --- | --- |
| 호스트 | Windows 11, i9-14900HX 24코어/32스레드, Docker 32 CPU·16GiB |
| 클러스터 | kind `peaket` 단일 노드, v1, 새 클러스터 |
| 합본 | 복제 3, CPU 요청=한도 4, **메모리 요청=한도 2Gi**, **모드 split**, HPA 끔 |
| split 구성 | 이 프로세스 admission-ctrl·queue-svc, 자식 payment-svc(8084)·purchase-svc 전체(8081)·purchase-svc 홀드 전용(8083, DB·Kafka 없음) |
| PostgreSQL | v1 전용, `max_connections 600`, 메모리 요청 1Gi·한도 2Gi |
| Relay | purchase·payment outbox relay 각 2대. **relay가 없으면 결제 결과가 5초 pull로만 반영돼 p99가 9초까지 밀린다** |
| 부하 | v1 payment, 100/s, 좌석 2, 응답 버림 5%·16,000ms 지연 0.5% |
| 발생기 | K7 1대(CPU 4·메모리 3Gi), K2 스모크 1대(1,000/s) |

## 2. K7 100초 결과

| 실행 | 조건 | 결제 확정 p99 | p95 | 홀드 k6 p99 | 주문/접수/결제 실패 | 판정 |
| --- | --- | ---: | ---: | ---: | --- | --- |
| r1 | split, 2Gi, 상태 조회 200ms | **3,039.9ms** | 2,079.2ms | 243.9ms | 2.4% / 5.7% / 4.9% | **유효**(놓침 0·`startSkewS=0`) |
| r2 | r1 + 상태 조회 100ms | 9,090.0ms | 8,134.5ms | 200.9ms | 1.4% / 5.7% / 4.1% | **무효**(놓침 294, VU 1,450) |

- r1은 목표 3,000ms를 **39.9ms 초과**했다. p90 1,861ms·p95 2,072ms로 분포는 목표 안이며, 3초를 넘는 꼬리는 990/9,206(10.75%)다.
- r2는 상태 조회를 100ms로 줄인 실험이지만 **놓침 294로 무효**였고 p99도 9,090ms로 악화됐다. 원인을 가르지 못한 채 남기지 않으려고 **200ms로 되돌렸다**(커밋 코드는 r1과 같은 200ms).
- r2의 악화는 새 클러스터의 relay 리더 election/워밍과 겹쳤을 가능성이 있으나, 무효 실행이라 원인 판정에 쓰지 않는다.

## 3. 40초 실험(원인 분해)

| 실행 | 조건 | 결제 확정 p99 | 홀드 k6 p99 | 판정 |
| --- | --- | ---: | ---: | --- |
| split 1발생기 | 100/s, relay 정상 | 3,078.5ms | 155.5ms | 유효 |
| split 2발생기 | 100/s, 발생기 2대·1.5Gi | 14,396ms(발생기별)/5,323ms(합계) | 92.0~109.5ms | 유효·참고용 |
| split relay 없음 | 100/s, relay Deployment 없음 | 9,622ms | 157.9ms | 유효·원인 진단 |

- relay가 없는 첫 split 실행은 `payment.created→approved`가 정상인데도 주문 APPROVED가 6.2초(p50)였다. payment outbox `sent_at`이 전부 비어 있었고, purchase-svc의 5초 결과 pull이 유일한 길이었다. `cluster.mjs v1`을 끝까지 돌려 relay를 만들자 같은 코드가 p99 3.04초로 내려왔다.
- 2발생기 실행은 홀드 p99를 92~109ms로 낮췄지만 결제 p99가 발생기별 14.4초/합계 5.3초로 나빠져 K7 조건으로 쓰지 않는다.

## 4. 홀드 경로

| 지표 | 값 | 비고 |
| --- | ---: | --- |
| K2 스모크 1,000/s 홀드 p99 | **11.1ms** | 1발생기, 유효, 서버·클라이언트 모두 50ms 안 |
| K7 40초 홀드 k6 p99 | 155.5ms | 서버 `hot_path` 라우트 p99 **43.4ms** |
| K7 100초 홀드 k6 p99 | 243.9ms | 1발생기 |
| K7 100초 홀드 k6 p95 | 157.8ms | p90 102.5ms |

- 홀드 전용 자식 프로세스는 `purchase-svc`를 DB·Kafka 없이 띄운다(포트 8083). 세션·좌석 홀드는 Redis, 좌석맵 판은 같은 hostPath라 전체 purchase-svc와 상태를 공유한다.
- **서버 쪽 홀드 라우트 p99는 43.4ms로 50ms 안**이다. k6 홀드 p99 155~244ms는 같은 1발생기가 주문·결제·상태 롱 폴링까지 처리하는 측정 오버헤드다. K2 스모크(1,000/s, 홀드만)에서는 11.1ms다.
- 50ms 게이트는 k6 `route:hold` 지표를 쓰므로 **게이트 기준으로는 미달**이다. 서버 SLI와 k6의 차이를 다음 배치에서 `latency_crosscheck`로 확정한다.

## 5. 트랜잭션 축소

- 승인 실행기의 `claimDue`가 `payment` 행과 `CONFIRM_SENT` 유무를 같은 트랜잭션에서 함께 읽고 `ConfirmJob.target`으로 넘긴다. 실행기는 `payment.confirm.read`를 다시 묻지 않는다.
- `payment.confirm.read` 표본이 사라졌고, `payment.confirm.claim` p95 13.7ms·mark p95 45.8ms·finish p95 31.5ms(40초 split)로 이전(claim 275.8ms·mark 428.2ms·finish 451.1ms)보다 줄었다. 결제 확정 p99는 7.4→3.04초로 내려왔다.
- 결과 소비·발권 트랜잭션 수는 계측만 하고 더 줄이지 못했다. ticket issue는 claim+complete 두 트랜잭션, 결과 소비는 이벤트당 한 트랜잭션이다.

## 6. 남은 일(OPEN[38])

1. **K7 ② 3회**: 새 클러스터·split·2Gi·relay 포함, 1발생기 100초. r1 3,039.9ms를 기준선으로 3회 중앙값을 낸다.
2. **A/A 쌍**: K2 quiet 2회. split 무대에서 4발생기 메모리(1Gi×4)가 16Gi에 들어가는지 먼저 확인한다.
3. **K2 3회**: 50ms 목표. 스모크 11.1ms는 좋지만 정본 2,000/s·4발생기로 다시 잰다.
4. **A등급 게이트**: 변이 2개 이상, 복구 장애 주입, trace-check, test-int, 4관점 리뷰, 성능 장부. 이번 커밋은 최소 게이트(typecheck·단위·lint·doc-check·ledger·records)만 통과했다.
5. **홀드 k6 vs 서버 SLI**: 50ms 게이트를 서버 `hot_path`로 볼지 k6로 볼지 정본 결정이 필요하다. k6라면 발생기 분리/전용 홀드 발생기 설계가 필요하다.
6. **relay 준비 확인**: split 무대는 relay Deployment가 반드시 있어야 한다. `cluster.mjs v1`이 relay helm까지 끝났는지 `infra.txt`/`get deploy`로 확인한다.
