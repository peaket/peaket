# BAT-037 결과 — purchase-svc 쓰기 경로 HTTP 백프레셔

- 날짜: 2026-11-12
- 묶음: BAT-037(HOT-471, 갈래 1, A등급, 0.5~1일 [가정])
- 장부 범위: `P-T1`, `P-T23`
- 선행: BAT-035(HOT-469, R-505). K7 진단 r2는 유효했지만 429 159/9,354(1.70%)·confirm p99 4,320.36ms로 미달했다.

## 1. `payment-status` 롱 폴링의 DB 연결 사용

### 코드 확인

- `GetPaymentStatus.answer`는 주문 모습을 한 번 읽고, 기다릴 상태면 `PaymentStatusWaitTable.wait`에 맡긴다. 기다리는 동안 DB를 부르지 않는다.
- `PaymentStatusWaitTable`의 200ms 묶음 조회는 전용 일반 풀(`purchase-svc-payment-status`, max 2)을 쓴다(BAT-029). 요청 경로 단건 읽기는 핫패스 풀을 쓰지만 질의마다 빌려 곧바로 돌려준다.
- 따라서 **롱 폴링 대기 동안 DB 연결을 쥐는 코드는 없다.** (가)는 이미 구현되어 있다.

### K7 r2 로그 수치

`.cache/peaket-bat033/k7-diag-bat035-r2/` 번들 3파드 요청 로그(200은 10% 표본, 429는 전수):

| `payment-status` | 건수 | p50 | p90 | p99 | 최대 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 | 1,106(표본) | 1,300.97ms | 2,155.62ms | 6,010.62ms | 18,008.46ms |
| 429 | 203(전수) | 267.24ms | 1,805.24ms | 2,385.90ms | 4,201.70ms |

- 429 143건(70.4%)은 300ms 미만 = 첫 읽기가 핫패스 풀 대기(250ms) 뒤 끝난 것.
- 429 55건(27.1%)은 1~3초 = 롱 폴링으로 기다린 뒤 깨어난 읽기가 풀에서 끝난 것. 기다린 시간이 섞인 값이지 연결 보유 시간이 아니다.
- 200의 긴 꼬리(6초·18초)도 롱 폴링 대기 시간이다.

### 쓰기 경로 429(전수)

| 경로 | 429 수 | p50 | p90 | p99 | 성공 p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/v1/orders` | 385 | 515.06ms | 616.17ms | 688.66ms | 556.40ms |
| `/v1/orders/{orderId}/payments` | 368 | 522.71ms | 926.06ms | 1,113.67ms | 588.64ms |
| `/v1/orders/{orderId}/payment-acceptance` | 198 | 433.37ms | 717.18ms | 923.17ms | 548.36ms |

- 쓰기 429는 951건, 429도 433~523ms를 기다린 뒤 끝난다. 핫패스 풀 포화가 직접 원인이다.
- `payment-status` 429 203건은 쓰기 429보다 적고 읽기도 짧다. 롱 폴링이 풀을 오래 잡아 쓰기를 굶기는 구조가 아니다.

### 결론

- (가) 기다리는 사이 연결 반환: 이미 되어 있다. 바꿀 코드가 없다.
- (나) `payment-status` 전용 읽기 풀: 묶음 조회는 이미 전용 풀이다. 단건 읽기까지 옮겨도 핫패스에서 빼는 몫이 작아 쓰기 429 951건을 설명하지 못한다. 2차 후보로 둔다.
- (다) HTTP 백프레셔: 쓰기 경로의 풀 포화가 직접 원인이라 가장 작은 유효 수정이다.

## 2. 고른 수정

- 플랫폼 `@Bulkhead(RouteBulkhead)` 장식자를 더했다. 기존 `RouteBulkhead`(ADR-0257 결정 2)와 같은 자리 셈을 쓰고, 본문 상한 없이 경로에 붙일 수 있다.
- purchase-svc 세 쓰기 경로에 같은 이름 `purchase-write`로 붙였다.
  - `POST /v1/orders`
  - `POST /v1/orders/{orderId}/payments`
  - `POST /v1/orders/{orderId}/payment-acceptance`
- 기본 한도 64(핫패스 풀 max 16의 4배), `Retry-After: 1`. 환경 값 `PEAKET_PURCHASE_WRITE_BULKHEAD_LIMIT`(1~1,024, 기본 64)로 조정한다.
- `payment-status`에는 칸막이를 달지 않았다. 롱 폴링은 연결을 쥐지 않고, 이 경로를 자르면 결과를 기다리는 정상 사용자를 먼저 거절한다.

## 3. 시험

- 플랫폼 `test/body-limit.test.ts`: `@Bulkhead`가 본문 상한 없이 동작하고, 자리가 차면 429 `server-busy`+Retry-After, 응답이 끝나면 자리를 놓는지. 이름·한도·Retry-After 검증. **9건 통과**.
- purchase-svc `test/write-bulkhead.test.ts`: 기본 64·1~1,024 검증, 시작 때 바꾼 한도가 같은 객체에 적용되는지. **3건 통과**.
- purchase-svc `test/orders-http.test.ts`: 주문 생성이 처리기에서 자리를 쥐고 있으면 둘째 주문 생성이 DB에 가기 전에 429 `server-busy`+Retry-After. **통과**.
- purchase-svc 단위 전체 **95파일 3,708건 통과**, 플랫폼 단위 전체 **41파일 517건 통과**.
- typecheck: `@peaket/platform`·`@peaket/purchase-svc` 통과. lint: 오류 0.
- 변이 5개: 칸막이 한도 검사 제거, Retry-After 0, 응답 finish·close에서 자리 놓기 제거, 주문 생성 경로 칸막이 제거, 기본 한도 64→1. **5개 모두 잡혔다(놓침 0).**
- 4관점:
  - 정확성: 칸막이는 본문 해석 전(onRequest)에 자리를 잡고, 응답 finish/close에서 놓는다. 세 쓰기 경로가 같은 이름 `purchase-write`를 쓴다. **높음·중간 없음.**
  - 동시성/장애: 파드별로 세고, 손님이 끊어도 처리기가 끝날 때까지 자리를 쥔다. 한도가 차면 429+Retry-After로 빨리 돌려보낸다. **높음·중간 없음.**
  - 보안: 429는 기존 `server-busy` 문제 모양이고, 환경 값은 1~1,024만 받는다. 새 비밀·로그 없음. **높음·중간 없음.**
  - 데이터 불변식: 칸막이는 처리기 앞에서 거절하므로 주문·결제 쓰기를 바꾸지 않는다. 기존 주문·결제 HTTP 시험 136건이 통과했다. **높음·중간 없음.**
- 낮음: 기본 64는 K7 전 시작값이다. 파드별 칸막이라 3복제면 서비스 전체 192다. `server-busy` 429는 칸막이와 DB 풀 대기가 같은 이름이라 로그 `durationMs`로 가른다.
- Docker test-int·K7은 이번에 돌리지 않았다(갈래 3 BAT-210 heavy gate가 Docker 사용, K7은 measurement go 뒤).

## 4. 다음

- K7 진단 1회를 같은 조건(split·2Gi·relay 정상·CPU 4·새 클러스터)으로 돌린다.
- 확인: 접수 429 <1%, `payment_confirm_ms{phase:main}` p99 <3,000ms, dropped 0·시나리오 오류 0·`startSkewS=0`, `payment_end_truncated_terminal`·`_pending`.
- 429 `durationMs`로 가른다: 즉시(수 ms)면 칸막이 → 한도를 올린다. 250ms 근처면 핫패스 풀 → 한도를 내리거나 (나) 전용 읽기 풀을 2차로 검토한다.
- 세 경로 429 `server_busy` 로그 수와 `payment_accept_status{phase:main,status}`를 함께 남긴다.

## 5. 한계

- 기본 64는 K7 r2 동시성 추정(55~59)과 핫패스 풀 16의 4배로 고른 시작값이다. K7 전에 429 <1%를 증명한 값이 아니다.
- 칸막이는 파드마다 따로 센다. 3복제면 서비스 전체 192다.
- `server-busy` 429는 칸막이와 DB 풀 대기가 같은 이름이다. 로그 `durationMs`로 구분한다.
- K7 시나리오는 429를 재시도하지 않으므로, 한도가 낮으면 429 비율이 바로 오른다.
