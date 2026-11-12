# BAT-035 결과 — purchase-svc 세 경로 트랜잭션 DB 연결 보유 시간

- 날짜: 2026-11-12
- 묶음: BAT-035(HOT-469, 갈래 1, A등급, 0.5~1일 [가정])
- 장부 범위: `P-T1`, `P-T23`
- 선행: BAT-034(HOT-468, R-501) 핫패스 연결 대기 250ms

## 1. 진단 수치

K7 진단 1회(`.cache/peaket-bat033/k7-diag-bat034/`):

| 항목 | 값 |
| --- | ---: |
| 접수 호출 | 9,402 |
| 202 | 9,136 |
| **429 `server-busy`** | **265 (2.82%)** |
| 503 | 1 |
| `payment_confirm_ms` p99 | 4,065.35ms |
| `payment_end_truncated_terminal` / `_pending` | 452 / 19 |
| dropped / 시나리오 오류 / startSkewS | 0 / **16** / 0 |

- 429 `durationMs`: 접수 p50 385ms·p90 673ms·p99 811ms, 주문 p50 476ms·p90 589ms, 결제 시작 p50 502ms·p90 790ms.
- 성공 202 p50 533ms·p90 838ms·p99 1,049ms. 250ms를 기다리고도 실패하는 요청이 남았다.

## 2. 문장 수·시간

실제 PostgreSQL 18에서 각 경로를 한 번씩 실행하고 `tx.execute`를 감싸 셌다.

| 경로 | 고치기 전 | 고친 뒤 |
| --- | ---: | ---: |
| 주문 생성 | 8문장 / 18.2ms | **6문장 / 18.0ms** |
| 결제 시도 시작 | 9문장 / 8.8ms | **8문장 / 9.3ms** |
| 결제 접수 | 14문장 / 13.3ms | **11문장 / 10.9ms** |

- 공통 멱등 기록 4문장(락 한도 설정·키 INSERT·기본값 복원·결과 참조 UPDATE)은 원자성 때문에 유지했다.
- `itemsOf`·`reachedBeforeOf`는 **중복이 아니었다**. T3(AUTHENTICATED)는 사건이 없어 읽지 않고, T4(ACCEPTED)만 `itemsOf` 1회·`reachedBeforeOf` 1회를 읽는다. 실제 계측도 `itemReads=1`, `reachedBeforeReads=1`이다.
- 접수의 실제 중복은 **T3 UPDATE + T4 UPDATE**, **T3 이력 INSERT + T4 이력 INSERT**, 별도 `seat_gen` UPDATE였다.
- 주문 생성은 주문·항목·이력 INSERT 세 번, 결제 시작은 시도 수 SELECT·대체 UPDATE·새 시도 INSERT 세 번이었다.

## 3. 고른 수정

1. 주문 생성: 주문 행·항목·이력 1을 한 CTE 문장으로 묶었다. Outbox는 기존처럼 마지막 업무 문장이다. 8→6.
2. 결제 시도 시작: 이전 READY 대체는 순서를 지켜 별도 문장으로 두고, 시도 수 SELECT와 새 시도 INSERT를 한 CTE로 묶었다. 9→8.
3. 결제 접수: T3·T4를 한 조건부 UPDATE(`event_seq + 2`, `seat_gen` 병합)와 한 `order_event` 다중 행 INSERT로 썼다. T4 사건은 `acceptTransitions`가 만들고, Outbox는 결제 시도 UPDATE·Saga INSERT 뒤 업무 문장의 마지막에 쓴다. 14→11.
4. BAT-034의 250ms 연결 대기는 유지했다.

## 4. 시나리오 오류 16건 — 측정 방법 문제

- 16건은 모두 `409 already-admitted`였고, 계정 16개가 모두 서로 달랐다. 같은 계정의 중복 진입이 아니다.
- 16건 모두 본구간 끝(21:13:21.879~.947)에 몰렸다.
- 원인: k6 `exec.scenario.iterationInTest`는 **시나리오별 0부터 세는 번호**다. 예열 10초×100/s는 1,000번, 본구간 100초×100/s는 10,000번이 계획인데, k6가 끝에서 몇 번을 더 돌면(진단 실행은 11,020번) 예열의 꼬리 번호가 `USERS-1-it`로 내려와 본구간의 끝 번호 `it`와 같은 사용자를 가리킨다. BAT-034 진단은 예열·본구간이 계획보다 9번씩 더 돌아 16명이 겹쳤고, 예열에서 이미 입장한 사용자가 본구간 진입에서 409를 받았다.
- 수정: `loadtest/lib/v1.mjs`의 `paymentUserOf`는 예열은 뒤에서(`USERS-1-it`), 본구간은 앞에서(`it`) 세되, 계획한 반복 수(`RATE*WARM_S`, `RATE*MAIN_S`)를 넘는 꼬리 번호는 `-1`로 돌려보낸다. `pay()`는 이미 `i < 0`이면 요청을 보내지 않는다. 계획 밖 꼬리 반복만 버리고 제품 요청을 줄이는 것이 아니다. 계획+8 꼬리까지 넣은 단위 시험으로 두 범위가 겹치지 않고 꼬리가 -1이 되는지 확인했다.
- 판정: **제품 문제가 아니라 측정 방법 문제**다.

## 5. 시험

- 구매-svc 단위 7파일: **459건 통과**(주문 생성·결제 시작·접수·HTTP·주문 상태 SQL).
- 실제 PostgreSQL 통합: `order-writes`·`start-payment`·`order-accepts` 102건 + BAT-035 문장 수·순서 1건 + BAT-034 풀 2건 = **105건 통과**. `accept-e2e` **25건**, `orders-e2e` **34건**도 통과했다.
- purchase-svc test-int **전체: 46파일 1,795건 통과**(2026-11-12, 실제 PostgreSQL·Redis, Docker). 첫 전체 실행에서 `payment-model`의 V-T40 웹훅 집중 시험 1건이 실패했다. 결제 시스템은 `fakeClock`을 쓰는데 웹훅 수신기만 `systemClock`을 써서, `UNKNOWN`의 `next_query_at`(250ms 뒤)이 실제 시각보다 먼저 지나면 첫 웹훅이 `query_signal`이 아니라 `query_signal_skipped`가 됐다. 웹훅 수신기도 같은 `fakeClock`을 쓰도록 고쳐 결정적으로 만들었고(제품 동작 변화 없음), 다시 46파일 1,795건이 통과했다.
- BAT-035 문장 시험: create 6, start 8, accept 11, 접수 `itemsOf`/`reachedBeforeOf` 각 1, Outbox가 Saga INSERT 뒤·멱등 결과 UPDATE 앞.
- 시나리오: `paymentUserOf` 단위 시험 통과, loadtest v1 시험 **48건 통과**.
- typecheck: 영향 패키지(`@peaket/platform`, `@peaket/purchase-svc`) 통과.
- lint: 오류 0.
- doc-check: 오류 0(기존 경고 4).
- `ledger --batch BAT-035 --require`: 통과.
- trace-check `P-T23`: 통과.

## 6. K7 진단 결과(2026-11-12)

- 산출물: `.cache/peaket-bat033/k7-diag-bat035-r2/` (커밋하지 않음). 새 클러스터(split·2Gi·relay 정상·CPU 4), `v1 payment` 100/s, 예열 10초·본구간 100초, 좌석 2, 응답 버림 5%·16초 지연 0.5%, 발생기 1대 CPU 4·3GB.
- 유효: dropped 0, 시나리오 오류 0, `startSkewS=0`, VU 최대 1,201, 발생기 CPU 평균 최고 57.4%·메모리 최대 75.1%.
- 첫 실행은 `paymentUserOf`가 시나리오별 반복 번호를 전체 번호로 잘못 본 탓에 본구간 앞 1,006번이 사용자 번호를 잃어(홀드 8,994) 비교에 쓰지 않았다. `f8ed4cfa`에서 고친 뒤 r2를 쟀다.

| 항목 | r2 | 목표 | 판정 |
| --- | ---: | ---: | --- |
| 접수 호출 | 9,354 | - | - |
| 202 | 9,195 | - | - |
| 429 `server-busy` | **159 (1.70%)** | <1% | **미달** |
| 503 | 0 | - | - |
| `payment_confirm_ms{phase:main}` p99 | **4,320.36ms** | <3,000ms | **미달** |
| `payment_end_truncated_terminal` / `_pending` | 476 / 21 | - | - |
| `payment_outcomes` PENDING | 393 | - | - |
| 공식 `payment_p99_3000ms` 위반 | 907/9,354 (9.70%) | ≤1% | **미달** |

- 429 `durationMs`(번들 로그, 예열 포함): 주문 p50 515ms·p90 616ms·p99 689ms, 결제 시작 p50 523ms·p90 926ms·p99 1,114ms, 접수 p50 433ms·p90 717ms·p99 923ms. 429도 250ms 대기 뒤에 끝나며 빠른 거절이 아니다.
- 세 경로 429 `server-busy` 로그 수(예열·본구간 합, 번들 3파드): `/v1/orders` **385**, `/v1/orders/{orderId}/payments` **368**, `/v1/orders/{orderId}/payment-acceptance` **198**. 그 밖에 `/v1/orders/{orderId}/payment-status` 203. 모두 `type=server-busy`이고 503은 0이다.
- 판정: BAT-035의 문장 수 축소(8/9/14→6/8/11)와 BAT-034의 250ms 대기로는 429 <1%·confirm p99 <3초를 맞추지 못했다. **공식 K7 3회는 시작하지 않는다.**
- 다음 후보: **(라) HTTP 백프레셔**를 BAT-036 후보로 제안한다. 입구에서 처리 한도·대기열을 두어 429를 늦게까지 기다리게 하지 않고, 성공 요청의 p99를 지키는 쪽이다. 다만 BAT-036 번호는 현재 SEG-010(구간 마무리, C)에 쓰이고 있어, 실제 배치 번호는 다음 빈 번호로 확정해야 한다.

## 7. 변이·4관점 리뷰(2026-11-12)

### 변이

15개 변이를 넣고 해당 시험을 돌렸다. **15개 모두 잡혔다(놓침 0).**

- BAT-035: `event_seq +2→+1`, `seat_gen` 제거, T3 seq `seq-1→seq`, T3/T4 status 뒤바꿈, T3 이력 from/to 뒤바꿈, Outbox를 Saga 앞으로, 시도 상한 `<→<=`, SUPERSEDED 제거, create `order_item` CTE 비우기, create event seq `1→2`.
- BAT-034: 기본 250→100, 범위 검증 5,000→100,000.
- BAT-033: 끝 경계를 `!terminal` 뒤로, `_terminal`/`_pending` 맞바꾸기, 끝 경계 3,000→2,999.
- 사용 시험: `order-accepts`·`start-payment`·`order-writes`·`bat035-transaction-statements` test-int, `db-pool-config` 단위, BAT-033 단위·M6 k6 시험. 전체 test-int는 46파일 1,795건 통과로 다시 확인했다.

### 4관점 리뷰

- **정확성**: T3/T4 한 UPDATE의 `event_seq +2`·두 이력 행·T4 사건·`seat_gen` 병합이 기존 전이 표와 같다. create CTE는 주문·항목·이력을 한 문장으로 쓰고 Outbox를 마지막에 둔다. start CTE는 대체 뒤 시도 수와 INSERT를 묶고 활성 유일 인덱스를 유지한다. **높음·중간 없음.**
- **동시성/장애**: 주문 행 잠금(T3/T4) → 결제 시도 UPDATE → Saga INSERT → Outbox 순서다. 시도 UPDATE·Saga INSERT·Outbox가 실패하면 트랜잭션째 되돌린다. start는 주문 행 잠금 뒤 대체→카운트+INSERT라 동시 시작이 직렬화되고, 유일 인덱스가 마지막 안전망이다. **높음·중간 없음.**
- **보안**: 새 SQL은 모두 매개변수화되어 있고, 결제 참조·토큰을 로그·오류에 싣지 않는다. 새 환경 값은 비밀이 아니며 범위를 검증한다. **높음·중간 없음.**
- **데이터 불변식**: P-T23(한 주문 한 접수), 주문 이력 seq/상태, `seat_gen`, Saga 작업 한 행, Outbox 마지막 문장을 기존 test-int와 변이가 확인했다. **높음·중간 없음.**
- **중간 지적 1건(고침)**: `paymentUserOf`가 k6 `iterationInTest`를 시험 전체 번호로 잘못 보고 본구간에서 예열 반복 수를 빼면, 실제로는 시나리오별 번호라 본구간 앞 1,006번이 사용자 번호를 잃는다. 시나리오별 계획 수(`RATE*WARM_S`, `RATE*MAIN_S`)를 넘는 꼬리만 -1로 버리도록 고쳤다. 계획+8 꼬리 단위 시험으로 두 범위가 겹치지 않고 꼬리가 버려지는지 확인했다.
- **낮음**: `hotConnectTimeoutMsFromEnv`가 `Number(raw)`라 `0x10`·`1e3` 같은 표기도 받는다. 범위(1~5,000)는 지키므로 보안·동작 영향은 없고, 다음 정비 때 10진수 정규식으로 좁힌다.
- **낮음**: `acceptTransitions`는 `at`이 Date인지 직접 보지 않는다. 호출자(`DrizzleOrderAccepts`)가 `new Date(clock.now())`를 넘긴다.
- **낮음**: create CTE의 `items`는 최종 SELECT가 참조하지 않는 data-modifying CTE다. PostgreSQL이 실행하지만, 변이(`where false`)가 항목 누락을 잡는지 확인했다.
- **낮음**: 큰 시험은 본구간 앞 6회를 사용자 번호 여유로 비워 둔다(10,000회 중 6회, 0.06%). 공식 점검의 분모는 실제 접수 호출 수라 429 비율 계산에는 영향이 없다.
