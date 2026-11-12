# 완성 장부: payment

`tools/ci/ledger.mjs`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 `docs/review/ledger-notes.md`). 원천: `docs/features/payment.md`, `docs/security/asvs/payment.md`. 전체 개수와 이 도구의 한계는 `docs/review/ledger/README.md`에 있다.

| 등급 | 자동 시험 | ID만 | 측정 | 사람 확인 | 미검증 | 다른 단계 | 없앰 | 해당 없음 | 빈칸 | 합계 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 70 | 26 | 6 | 0 | 2 | 12 | 0 | 0 | 0 | 116 |
| B | 56 | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 13 | 89 |
| 합계 | 126 | 46 | 6 | 0 | 2 | 12 | 0 | 0 | 13 | 205 |

## docs/features/payment.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| P-T1 | — | K7 카오스 장애 주입 1만 건 | 이중 결제 0건, P3 시작 시각 뒤 60초 안에 발권되지도 발권 재시도 큐에 들어가지도 않은 결제 0건, 큐의 건은 발권 기한(30분 [가정]) 안에 모두… | 측정 | A | HOT-470 · K7 카오스 장애 주입 1만 건. v1 K7 ② 2026-11-11-k7-v1-fault-r1·r2는 발생기 놓침 1,068·1,157, 시나리오 오류 179·199로 무효… |
| P-T2 | — | 승인 실패 모의 검증 | DB PENDING 레코드 삭제, 좌석 비트맵 해제, 금융 과금 0건, 사용자 안내가 정상인지 확인한다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/payment-result-e2e.int.test.ts… |
| P-T3 | — | 승인 응답 유실 및 재전송 | 결제가 단 1건만 최종 체결되고 중복 승인이 0건임을 입증한다. `drop`(응답 버림)으로 `UNKNOWN`이 된 결제가 단독 조회로 승인되는 동안 승인… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-unknown-resolver.int.test.ts, services/payment-svc/test/payment-schema.test.ts… |
| P-T4 | — | 결제 접수 p99 지연시간 | 202 Accepted 응답의 p99 지연시간 < 150ms와, 서비스를 멈춤 없이 쓸 수 있는 정도인 가용성 99.95%를 유지한다. | 측정 | A | 구간 측정 · 결제 접수 p99 |
| P-T5 | — | 결제 최종 확정 p99 지연시간 | 결제 확정 p99 3초 이내(PG 2초 + 내부 1초. 2초는 끊는 값이 아니라 나눠 재는 예산이다)와 결제 완료율 99.95%를 달성한다. 완료율… | 측정 | A | 구간 측정 · 결제 최종 확정 p99 |
| P-T6 | — | 승인 유효기한 초과 검증 | 승인 API를 호출하지 않고 주문을 안전하게 만료로 끝내며, 금융 과금 0건을 확인한다. 첫 구현은 시뮬레이터로 기한 지난 명령의 승인 호출 0건과… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts, services/payment-svc/test/confirm-runner-domain.te… |
| P-T7 | — | 결제 금액 변조 차단 | 서버 검증에서 400 Bad Request로 바로 거절되고, 결제 접수가 막힌다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test/accept-http.test.ts 외 3곳 |
| P-T8 | — | 웹훅 중복 및 본문 위조 방어 | 중복 건은 1회 처리되고, 가짜 본문은 단독 조회 API로 검증해 안전하게 무시된다. | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-schema.test.ts 외 1곳 |
| P-T9 | — | 가상계좌 입금 보안 검증 | 입금 처리가 거부된다. 고수요 온세일 공연에서는 결제창에 가상계좌 수단 노출이 0건인지 확인한다. 첫 구현은 시뮬레이터와 PostgreSQL로 secret… | 자동 시험 | A | 시험: apps/web/src/_pages/checkout/model/payment-attempt.test.mjs, services/payment-svc/test-int/payment-deposit.int.test… |
| P-T10 | — | 홀드 만료 후 결제 접수 | 좌석이 비어 있으면 정상 확정되고, 다른 사람에게 홀드된 경우에는 금융 승인 없이 과금하지 않고 끝난다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/saga-e2e.int.test.ts |
| P-T11 | — | Degraded 결제 모드 검증 | 재시도 큐에 쌓아 두기, 새 결제 일시 정지, 홀드 TTL 연장(그 결제의 승인 기한까지), 주문을 만들고 결제 접수 전인 홀드의 남은 시간 멈춤과 다시 열린… | 측정 | A | 구간 측정 · Degraded 결제 모드 |
| P-T12 | — | 결제 중 세션 수명 유지 | 구매 세션과 입장 자리가 만료되지 않고 유지되며, 결제에 성공하면 바로 안전하게 비워진다. | 자동 시험 | A | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/payment-result-e2e.int.test.ts… |
| P-T13 | — | 주문 상태 이력 역추적(추천 적용 2026-10-28, ADR-0113) | 다시 구성한 전이가 실제 좌석 전이와 정확히 일치한다. 시험 데이터의 모든 주문에서 마지막 이력의 새 상태가 지금 상태와 같고, 빈 번호가 없으며… | 자동 시험 | A | 시험: services/purchase-svc/test/apply-payment-result.test.ts |
| P-T14 | — | PG 시뮬레이터 전환 검증 | 실제 외부 PG 호출을 0건으로 유지하면서 대규모 결제 SLO를 정밀하게 잰다. | 다른 단계 | A | 미정 · PG 시뮬레이터 전환 |
| P-T15 | — | 멱등 처리 무결성 | 티켓 발권이 정확히 1회만 실행되고(발권은 Saga가 gRPC로 부른다, architecture §3.2), 소비자가 같은 `eventKey`를 한 번만… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 12곳 |
| P-T16 | — | PG 어댑터 계약 테스트 | 세 어댑터 모두 같은 정규화 계약 결과를 돌려주고, 포트원 멱등키 따옴표 규격을 지킨다. 토스 어댑터의 첫 구현은 시뮬레이터 몫이다: 시뮬레이터 주소와… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-webhook.int.test.ts 외… |
| P-T17 | — | 포트원 웹훅 서명 검증 | 서명이나 헤더에 결함이 있는 요청은 바로 거절된다. 중복 건은 1회 처리되고, 지원하지 않는 이벤트는 안전하게 무시된다. 재전송의 `webhook-id`가… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-process.int.test.ts, services/payment-svc/test-int/payment-webhook.int.test.ts… |
| P-T18 | — | 공제율 산정 정확도 검증 | 공제 없음(전액 환불), 10%, 20%, 30%, 90% 공제가 정확히 적용되고, 24시간 이내 전액 환급에서 비영업일이 정확히 빠진다. 끝수(추천 적용… | 다른 단계 | A | 미정 · 공제율 산정 정확도 |
| P-T19 | — | 입장 개시 후 예매 취소 | 금융 환급이 보류된 뒤, '취소 뒤 입장' 이상 표시와 CS 확인으로 취소가 최종 무효 처리된다. 입장 기록이 없는 경우에만 입장 기록 마감 뒤 정상 환급된다. | 다른 단계 | A | 미정 · 입장 개시 후 예매 취소 |
| P-T20 | — | 회차 취소 일괄 환불 검증 | 모든 주문에 100% 전액 환급이 실행되고, 배상 대상 수·금액 합계와 상계·보증 충당·청구 내역이 정산 리포트에 들어가며(개인 명단은 넣지 않는다), 이중… | 다른 단계 | A | 미정 · 회차 취소 일괄 환불 |
| P-T21 | — | 취소 멱등성 및 재시도 검증 | 먼저 조회해 이미 취소됐는지 확인한 뒤 재전송해, 단 1회만 환급된다는 것을 입증한다. | 다른 단계 | A | 미정 · 취소 멱등성과 재시도 |
| P-T22 | — | PG 한도 추정 모델 검증 | 300 TPS 환경에서는 확정 p99 3초를 달성한다. 100 TPS 환경에서는 대기열이 10분 기한 안에 해소되고, 기한을 넘긴 건은 과금 없이 만료된다. 첫… | 측정 | A | 구간 측정 · PG 한도 추정 모델 |
| P-T23 | — | 주문당 활성 결제 1건 제한 | 두 번째 접수는 409 Conflict로 막힌다. 인증 단계의 이전 시도는 안전하게 대체되고, 승인이 진행 중일 때는 새 시도가 막힌다. 결제 시도… | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 6곳 |
| P-T24 | — | 승인 후 프로세스 중단 복구 | 프로세스가 다시 시작되면 단독 조회 API로 상태를 확인해, 1건만 정상 승인으로 반영되고 이중 승인은 0건이다. BUILD_ORDER PRF-181은 임대가… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts, services/payment-svc/test-int/payment-process.int… |
| P-T25 | — | 결제 거절 재시도 상한 검증 | 결제창 단계 실패는 같은 주문으로 3회까지 재시도할 수 있다. 4회째는 막히고 안내만 보이며, 좌석 홀드는 TTL까지 유지된다. 승인 단계 거절은 주문… | 자동 시험 | A | 시험: apps/web/src/_pages/checkout/model/attempt-flow.test.mjs, apps/web/src/_pages/checkout/model/payment-attempt.test.mj… |
| P-T26 | — | 결제사 선택 규칙 | 규칙 순서대로 결제사가 골라진다. 서버 승인을 지원하지 않는 채널이면 결제 시도가 만들어지지 않고, 다른 결제사로 넘어가지 않는다. PRF-190은… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 14곳 |
| P-T27 | — | 결제 시도 대체와 재선택 | 새 시도는 포트원 결제창으로 열린다. 이전 시도의 늦은 접수는 409로 막히고, 과금은 0건이다. 새 시도가 같은 결제사여도 본문 `attemptId`로… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 7곳 |
| P-T28 | — | 결제 접수 계약 검증 | 앞의 넷은 400·409로 거절된다. 포트원 금액 불일치는 승인 API가 거절해, 과금 없는 실패로 끝난다. 새 API로 시작한 시도로 생성 → 시도 → 접수… | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 7곳 |
| P-T29 | — | 결제사 고정 | 그 주문의 모든 호출이 기록된 결제사로만 가고, 다른 결제사 호출은 0건이다. PRF-190은 승인·조회·입금 전 취소까지 본다(부분 환불은 취소 단계, 추천… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test/pg-selection.test.ts 외 1곳 |
| P-T30 | — | 웹훅 결제사 확인 | 반영되지 않고, 보안 이벤트로 기록된다. | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외 1곳 |
| P-T31 | — | 결제사 전환 훈련과 결제사별 동시 입장 목표 상한 | 전환 뒤 공연의 serving 전진 속도 상한이 초당 50번호로, 동시 입장 목표가 채널 상한 기준(4,500명 [가정])으로 바로 낮아지고, 포트원 승인… | 측정 | A | 구간 측정 · 결제사 전환 훈련과 결제사별 동시 입장 목표 상한 |
| P-T32 | — | 결제사별 대사 | 결제사별 대사가 모든 불일치를 찾아 UNKNOWN 해소 경로로 넘긴다. 대사 실행은 다시 시작해도 같은 불일치를 한 번만 기록하고(이어 하기), 원장을 임의로… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-reconciliation.int.test.ts, services/payment-svc/test/payment-reconciliation.t… |
| P-T33 | — | 포트원 리디렉션 결제 토큰 | 리디렉션 쿼리에 `paymentId`·`txId`·`paymentToken`이 오고, 수동 승인이 성공한다. 오지 않으면 능력 플래그로 포트원을 고르지 않고… | 미검증 | A | 포트원 테스트 채널 · 실제 포트원 리디렉션 결제가 필요한데 포트원 테스트 채널 계정이 없다(HOT-145) |
| P-T34 | — | 결제사 한도 초과 응답과 결제 확정 임박 원인 경고 | 첫 429에 SEV2가 나고, `pg_throttled_total`이 늘며, 채널 상한이 바로 낮아진다. 공연 리포트에 피크 한도 사용률과 429 건수가… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-channel-limit.in… |
| P-T35 | — | identity-svc 중단 중 주문 생성 | 첫째만 주문이 만들어지고 나머지는 거부된다. 대체 판정 지표가 사유별로 늘고, 보안 이벤트 로그에 주문 ID가 남는다… | 자동 시험 | A | 시험: services/purchase-svc/test-int/identity-grpc.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts 외 5곳 |
| P-T36 | ① | 가상계좌 입금 대기 | ① 발권 … 을 payment-svc 원장·사건과 주문 전이까지 보고, 입금 대기 동안 결제 상태 응답의 은행·계좌번호·입금 기한도 본다(추천 적용… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts |
| P-T36 | ② | 가상계좌 입금 대기 | ② 주문 FAILED·좌석 반환·한도 복구, 웹훅 없이 조회로 판정 … 을 payment-svc 원장·사건과 주문 전이까지 보고, 입금 대기 동안 결제 상태… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.test.ts… |
| P-T36 | ③ | 가상계좌 입금 대기 | ③ 조회가 입금 완료면 발권(좌석 유지) … 을 payment-svc 원장·사건과 주문 전이까지 보고, 입금 대기 동안 결제 상태 응답의 은행·계좌번호·입금… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.test.ts… |
| P-T36 | ④ | 가상계좌 입금 대기 | ④ 티켓 VOIDED·키 폐기·좌석 PENDING, 재입금하면 새로 발권 … 의 첫 구현은 payment-svc·purchase-svc의 원장·사건·주문… | 자동 시험 | A | 시험: services/invariant-checker/test-int/invariants.int.test.ts, services/payment-svc/test-int/payment-deposit.int.test.t… |
| P-T36 | ⑤ | 가상계좌 입금 대기 | ⑤ 입금 전 취소로 FAILED. 모든 경우에 이중 발권 0건. 첫 구현은 … 의 첫 구현은 payment-svc·purchase-svc의 원장·사건·주문… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/deposit-reversal.test.ts 외 1곳 |
| P-T37 | ① | 판매 종료 전후 주문 | ① 홀드·결제 시간 안이면 201·202와 CONFIRMED | 자동 시험 | A | 시험: services/purchase-svc/test-int/orders-e2e.int.test.ts, services/purchase-svc/test/create-order.test.ts |
| P-T37 | ② | 판매 종료 전후 주문 | ② 지금 규칙대로 다시 시도 가능 | ID만 | A | 시험: services/purchase-svc/test-int/orders-e2e.int.test.ts, services/purchase-svc/test/create-order.test.ts 외 1곳 |
| P-T37 | ③ | 판매 종료 전후 주문 | ③ 410 `sale-ended`, 주문·과금 0건 | 자동 시험 | A | 시험: services/purchase-svc/test-int/orders-e2e.int.test.ts, services/purchase-svc/test/create-order.test.ts |
| P-T38 | — | 결제창에서 돌아온 첫 요청 | 복귀 화면의 첫 요청에는 팬 쿠키가 실리지 않고, 응답은 정적 셸이다(서버는 결제 값을 읽거나 로그에 남기지 않는다). 쿠키가 필요한 결제 접수는 페이지… | 미검증 | A | 실제 결제창 · 실제 결제창(토스 이동 방식, 포트원 리디렉션 방식)에서 돌아온 첫 요청은 결제사 계정이 있어야 본다. 브라우저 확인은 시뮬레이터로만 했다 |
| P-T39 | ① | 승인 뒤 발권 재시도와 발권 기한 | ① 결제 취소 0건, 재시도로 발권, 화면은 '결제 완료, 티켓 발급 중'이고 60초 넘으면 알림(`ISSUE_DELAYED`)과 SEV2 | 자동 시험 | A | 시험: services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/apply-payment-result.test.ts 외… |
| P-T39 | ② | 승인 뒤 발권 재시도와 발권 기한 | ② SEV1과 CS 처리함 `TICKET_NOT_ISSUED` 건, 재시도는 이어 간다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/ticket-issue-adapters.test.ts 외… |
| P-T39 | ③ | 승인 뒤 발권 재시도와 발권 기한 | ③ 일괄 환불 작업이 발권을 멈추고 결제를 취소해 COMPENSATED, 좌석 반환 | ID만 | A | 시험: services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/apply-payment-result.test.ts 외… |
| P-T39 | ④ | 승인 뒤 발권 재시도와 발권 기한 | ④ 자동 재시도를 멈추고 SEV2와 `TICKET_NOT_ISSUED` 건, 결제 취소 0건 | 자동 시험 | A | 시험: services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/ticket-issue-adapters.test.ts 외… |
| P-T39 | ⑤ | 승인 뒤 발권 재시도와 발권 기한 | ⑤ 불변식 SEV1(P3 시작 시각 뒤 60초 안에 발권도 큐 등록도 안 된 결제). 모든 경우에 이중 발권 0건 | ID만 | A | 시험: services/purchase-svc/test-int/ticket-issue.int.test.ts, services/purchase-svc/test/apply-payment-result.test.ts 외… |
| P-T40 | ① | 결제사 지연과 읽기 시간 초과 | ① 끊지 않고 결과를 받아 확정, 다시 보낸 호출 0건, 1분 창 p99 2초 초과로 SEV2 | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts |
| P-T40 | ② | 결제사 지연과 읽기 시간 초과 | ② 60초 [가정]에서 끊고 결과를 가정하지 않고 `UNKNOWN`으로 쓴 뒤 단독 조회로 확정한다(같은 멱등키로 다시 보내지 않는다, 명세 `timeout`… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts |
| P-T40 | ③ | 결제사 지연과 읽기 시간 초과 | ③ 상한을 넘는 승인 명령은 재시도 큐에서 승인 기한 안에 처리되고, 동시 승인 호출 수가 벌크헤드를 넘지 않으며 열린 승인 연결 수는 처음의 벌크헤드를 넘지… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts |
| P-T40 | ④ | 결제사 지연과 읽기 시간 초과 | ④ 채널 상한이 낮아지지 않고 그 호출만 다음 시도가 늦춰진다. 승인 명령 접수 gRPC는 모든 경우에 데드라인(200ms [가정]) 안에 답한다. 호출 보호… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test/pg-channel-limit.test.ts |
| P-T41 | ① | 결제하지 않은 티켓 주문의 만료 | ① 세 조건이 모두 끝난 때 주문 EXPIRED와 `trade.orders` EXPIRED, 결제사 호출 0건 | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-expiry.int.test.ts |
| P-T41 | ② | 결제하지 않은 티켓 주문의 만료 | ② 세션 종료와 홀드 해제 뒤 EXPIRED | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-expiry.int.test.ts |
| P-T41 | ③ | 결제하지 않은 티켓 주문의 만료 | ③ 접수가 먼저면 만료하지 않고 지금 규칙대로 처리, 만료 뒤의 시도·접수는 409 `order-expired` | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-expiry.int.test.ts |
| P-T41 | ④ | 결제하지 않은 티켓 주문의 만료 | ④ 안전망이 만든 지 90분 [가정] 지난 주문을 끝낸다. 과금 0건 | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-expiry.int.test.ts |
| P-T42 | ① | 굿즈 재고 예약 만료(core-svc shop. 같은 결제 포트를 써서… | ① 주문 Expired, 재고가 돌아와 다시 살 수 있다 | 다른 단계 | A | 미정 · 굿즈 재고 예약 만료(core-svc shop) |
| P-T42 | ② | 굿즈 재고 예약 만료(core-svc shop. 같은 결제 포트를 써서… | ② 연장된 시각까지 만료하지 않는다 | 다른 단계 | A | 미정 · 굿즈 재고 예약 만료(core-svc shop) |
| P-T42 | ③ | 굿즈 재고 예약 만료(core-svc shop. 같은 결제 포트를 써서… | ③ 하나만 이긴다(승인이면 재고 확정, 만료면 과금 0건) | 다른 단계 | A | 미정 · 굿즈 재고 예약 만료(core-svc shop) |
| P-T42 | ④ | 굿즈 재고 예약 만료(core-svc shop. 같은 결제 포트를 써서… | ④이전 주문이 Expired로 끝나고 재고를 돌린 뒤 새 주문이 생긴다 | 다른 단계 | A | 미정 · 굿즈 재고 예약 만료(core-svc shop) |
| P-T42 | ⑤ | 굿즈 재고 예약 만료(core-svc shop. 같은 결제 포트를 써서… | ⑤ 재고는 한 번만 돌아온다. 모든 경우에 초과 판매 0건 | 다른 단계 | A | 미정 · 굿즈 재고 예약 만료(core-svc shop) |
| P-T43 | ① | 새 결제 진입 정지와 다시 열기 | ① 시험 재개에서 정지로 돌아가고, 시험 결제의 과금은 0원이다 … , PromQL의 `path="direct"`를 본다. | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-entry-pause-judge.int.test.ts |
| P-T43 | ② | 새 결제 진입 정지와 다시 열기 | ② 바로 모두 열리고, 감사 로그에 사유와 commander가 남는다. 실패가 이어지면 연 뒤의 표본으로 다시 멈춘다 … , PromQL의… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-entry-pause-judge.int.test.ts |
| P-T43 | ③ | 새 결제 진입 정지와 다시 열기 | ③ 예상 대기가 10초 아래로 1분 이어지면 열리고, 확인 호출은 나가지 않는다 … , PromQL의 `path="direct"`를 본다. … 의 예상 대기를… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-channel-limit.int.test.ts, services/payment-svc/test-int/payment-entry-pause-j… |
| P-T43 | ④ | 새 결제 진입 정지와 다시 열기 | ④ 옛 판정자의 늦은 쓰기는 판 번호로 거절된다. 재시도 큐 건의 긴 확정 소요는 시작·해제 판정에 들어가지 않고, NFR-006 Degraded 측정에는… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-entry-pause-judge.int.test.ts |
| P-T44 | ① | 결제 결과 롱 폴링의 시간 초과 순서(추천 적용 2026-10-28… | ① 3초에 확정으로 답한다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/payment-status-e2e.int.test.ts |
| P-T44 | ② | 결제 결과 롱 폴링의 시간 초과 순서(추천 적용 2026-10-28… | ② 25초에 '확정 전' 상태로 답하고, 브라우저가 다시 물어 두 번째 응답에서 확정을 받는다 | ID만 | A | 시험: services/purchase-svc/test-int/payment-status-e2e.int.test.ts |
| P-T44 | ③ | 결제 결과 롱 폴링의 시간 초과 순서(추천 적용 2026-10-28… | ③ 같은 식으로 이어 묻다가 확정을 받는다 | ID만 | A | 시험: services/purchase-svc/test-int/payment-status-e2e.int.test.ts |
| P-T44 | ④ | 결제 결과 롱 폴링의 시간 초과 순서(추천 적용 2026-10-28… | ④ 게이트웨이가 27초에 504 Problem으로 끝내고 브라우저가 다시 묻는다. 모든 경우에 CloudFront가 한 조회를 원본에 다시 보낸 기록이… | ID만 | A | 시험: services/purchase-svc/test-int/payment-status-e2e.int.test.ts |
| P-T45 | ① | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ① 두 번째도 같은 201과 같은 주문 ID | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-writes.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts 외 2곳 |
| P-T45 | ② | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ② 422 `idempotency-key-reused`, 새 주문 없음 | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-writes.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts 외 2곳 |
| P-T45 | ③ | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ③ 1초 [가정] 기다린 뒤 409 `idempotency-request-in-progress`와 `Retry-After`, 첫 접수가 끝난 뒤 다시 보내면… | 자동 시험 | A | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 4곳 |
| P-T45 | ④ | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ④ 서로 다른 작업으로 따로 처리된다( | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-writes.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts |
| P-T45 | ⑤ | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ⑤ 서로 다른 작업으로 따로 처리된다( … 는 PRF-191: 멱등 범위가 계정 × 작업이라 같은 키의 주문 생성과 결제 시도 시작이 부딪치지 않는다, 추천… | 자동 시험 | A | 시험: services/purchase-svc/test-int/start-payment.int.test.ts |
| P-T45 | ⑥ | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ⑥ 새 요청으로 처리된다(주문은 이미 있으므로 홀드 상태에 따라 409 등 업무 규칙대로 끝난다) | 자동 시험 | A | 시험: services/purchase-svc/test-int/order-writes.int.test.ts, services/purchase-svc/test-int/start-payment.int.test.ts 외… |
| P-T45 | ⑦ | 주문·결제 멱등키의 범위·지문·처리 중·보관(추천 적용… | ⑦ 둘 다 400 `idempotency-key-invalid` | 자동 시험 | A | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/orders-http.test.ts |
| P-T46 | ① | 대체 채널의 하위 결제사(추천 적용 2026-10-28, 기술 검토… | ① 422이고 지정이 바뀌지 않는다 … 와 그 반대 방향(기본이 포트원)을 쓰임새 `AssignEventPg`와 PostgreSQL로, | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-sub-provider.int.test.ts, services/payment-svc/test/pg-sub-provider.test.ts |
| P-T46 | ② | 대체 채널의 하위 결제사(추천 적용 2026-10-28, 기술 검토… | ② 둘 다 422다(브랜드페이는 토스페이먼츠 상품, 토스페이는 확인 전) … 와 그 반대 방향(기본이 포트원)을 쓰임새 `AssignEventPg`와… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-sub-provider.int.test.ts, services/payment-svc/test/pg-sub-provider.test.ts |
| P-T46 | ③ | 대체 채널의 하위 결제사(추천 적용 2026-10-28, 기술 검토… | ③ 배포 검사가 실패한다 … 을 시작 설정 검사로, | 자동 시험 | A | 시험: services/payment-svc/test/pg-sub-provider.test.ts, services/payment-svc/test/process-config.test.ts |
| P-T46 | ④ | 대체 채널의 하위 결제사(추천 적용 2026-10-28, 기술 검토… | ④ SEV2가 뜨고 그 채널이 대체 후보에서 빠진다 … 를 포트원형 시뮬레이터의 채널 표와 PostgreSQL로(빠진 뒤에는 전환해도 기준 결제사로 간다. 설정… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-sub-provider.int.test.ts, services/payment-svc/test/pg-channel-sync.test.ts 외… |
| P-T46 | ⑤ | 대체 채널의 하위 결제사(추천 적용 2026-10-28, 기술 검토… | ⑤ 새 결제 시도가 포트원형으로 열리고 승인된다. 이 단계(PRF-203) 몫은 … 를 토스형·포트원형 시뮬레이터 둘과 PostgreSQL로 본다. 명령 12의… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-sub-provider.int.test.ts, services/payment-svc/test/pg-sub-provider.test.ts |
| P-T47 | — | 결제 결과 당기기(추천 적용 2026-10-29, ADR-0140) | 막힌 동안에도 당기기로 결제 확정이 p99 10초 [가정] 안에 끝나고, 60초 불변식 SEV1(P3 시작 시각 뒤 60초 안에 발권도 큐 등록도 안 된… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 5곳 |
| P-T48 | — | 인기 회차 결제 결과의 키 단위 동시 처리(추천 적용… | 결제 확정 p99 3초 안이다. 같은 주문의 사건은 순서대로 반영되고, 소비 지연(lag)이 늘기만 하지 않는다. 통과하지 못하면 결제 토픽을 주문 키 새… | 자동 시험 | A | 시험: services/purchase-svc/test/payment-result-handler.test.ts |
| P-T49 | ① | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ① 403 `booking-restricted`, 주문 행 0건, 두 좌석이 바로 풀려 다른 계정이 잡을 수 있다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/booking-restrictions.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test… |
| P-T49 | ② | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ② 홀드는 201, 주문은 다시 403 | 자동 시험 | A | 시험: services/payment-svc/test-int/purchase-path-e2e.int.test.ts |
| P-T49 | ③ | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ③ 받는다(막지 않는다) | ID만 | A | 시험: services/payment-svc/test-int/purchase-path-e2e.int.test.ts, services/purchase-svc/test-int/booking-restrictions.int… |
| P-T49 | ④ | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ④ 201 Order | 자동 시험 | A | 시험: services/purchase-svc/test-int/booking-restrictions.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test… |
| P-T49 | ⑤ | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ⑤ 10분 [가정] 안에 사본이 다시 서고 그 뒤 주문이 403이다 | 다른 단계 | A | GAT-310 · `SetBookingRestriction`을 받는 쪽이 생기는 GAT-310 뒤에 본다(시범 범위 표의 끝 문단) |
| P-T49 | ⑥ | 예매 제한의 주문 생성 집행(소유자 결정 2026-10-30… | ⑥ `PERMISSION_DENIED` | 다른 단계 | A | GAT-310 · `SetBookingRestriction`을 받는 쪽이 생기는 GAT-310 뒤에 본다(시범 범위 표의 끝 문단) |
| P-T50 | ① | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ① A·B의 승인 사건에 같은 `paymentMethodRef`와 6자리 `cardBin`이 실린다 … 과 원장·로그·사건의 0건)은… | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T50 | ② | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ② `paymentMethodRef`가 다르다 … 과 원장·로그·사건의 0건)은 `test-int/payment-method-ref.int.test.ts`가… | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T50 | ③ | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ③ 두 칸이 없다 … 과 원장·로그·사건의 0건)은 `test-int/payment-method-ref.int.test.ts`가 돈다. | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T50 | ④ | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ④ `cardBin`은 앞 6자리다. `issuer`가 빠지면 그 자리를 빈 글자로 두고 계산한 `paymentMethodRef`와 `cardBin`이 함께… | 자동 시험 | A | 시험: services/payment-svc/test-int/payment-method-ref.int.test.ts |
| P-T50 | ⑤ | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ⑤ 취소 사건에 승인 때와 같은 두 값이 있다 … 는 취소 단계가 만든다. | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T50 | ⑥ | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ⑥ 조회 응답의 카드 정보로 같은 값이 나온다 … 과 원장·로그·사건의 0건)은 `test-int/payment-method-ref.int.test.ts`가… | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T50 | ⑦ | 결제 수단 연결값(추천 적용 2026-10-31, ADR-0171… | ⑦ 보이는 자리 수가 기록과 다르면 스모크가 실패로 남고 계산식을 다시 본다. 결제 원장·로그·사건에 가린 번호와 카드 번호 원문이 0건이고, 분석 저장소… | ID만 | A | 시험: packages/contracts/test/generated-schemas.test.ts, services/payment-svc/test-int/payment-method-ref.int.test.ts 외 8곳 |
| P-T51 | ① | 결제 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ① `BehaviorSignal`(screen `PAYMENT`, `journeyId`, pid, 회차) 1건이고 `netClass`·`asn`·기기 가명이… | 자동 시험 | A | 시험: services/purchase-svc/test/grpc-payment-checkout.test.ts, services/purchase-svc/test/start-payment.test.ts |
| P-T51 | ② | 결제 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ② 신호가 늘지 않는다 … 의 purchase-svc 몫은 PRF-191 시험이 보고, 소비 쪽 0건은 적재 작업자가 생길 때 본다(추천 적용… | 자동 시험 | A | 시험: services/purchase-svc/test/start-payment.test.ts |
| P-T51 | ③ | 결제 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ③ 결제 시도는 정상이고 신호가 0건이다 … 의 purchase-svc 몫은 PRF-191 시험이 보고, 소비 쪽 0건은 적재 작업자가 생길 때 본다(추천 적용… | 자동 시험 | A | 시험: services/purchase-svc/test/start-payment.test.ts |
| P-T51 | ④ | 결제 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ④ 응답은 정상이고 버린 신호가 `telemetry_dropped_total`로 세어진다 … 의 purchase-svc 몫은 PRF-191 시험이 보고, 소비… | 자동 시험 | A | 시험: services/purchase-svc/test/grpc-payment-checkout.test.ts, services/purchase-svc/test/start-payment.test.ts |
| P-T51 | ⑤ | 결제 화면 행동 요약(추천 적용 2026-10-31, ADR-0171… | ⑤ 고른 결제사가 요약과 관계없이 §2.2 규칙대로다. `trust-reassess`의 원시 적재와 분석 저장소에 screen `PAYMENT` 신호가… | 자동 시험 | A | 시험: services/purchase-svc/test/start-payment.test.ts |
| P-T52 | ① | 주문 생성 사건의 조사용 칸(추천 적용 2026-10-31… | ① 두 CREATED 사건의 `contactRef`가 같고, `journeyId`가 그 구매 세션 입장 토큰의 `jny`와 같다 | 자동 시험 | A | 시험: services/purchase-svc/test-int/orders-e2e.int.test.ts, services/purchase-svc/test/create-order.test.ts 외 1곳 |
| P-T52 | ② | 주문 생성 사건의 조사용 칸(추천 적용 2026-10-31… | ② A 주문의 `contactRef`가 identity `account_contact_ref`의 B 휴대폰(PHONE) 값과 같다 | ID만 | A | 시험: services/purchase-svc/test-int/identity-grpc.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts 외 5곳 |
| P-T52 | ③ | 주문 생성 사건의 조사용 칸(추천 적용 2026-10-31… | ③ CREATED 밖의 주문 사건에는 두 칸이 없고, `PaymentEvent`에는 여정 ID가 없다. 조사 적재가 주문 ID로 결제 사건을 그 여정에 잇는다… | ID만 | A | 시험: services/purchase-svc/test-int/identity-grpc.int.test.ts, services/purchase-svc/test-int/orders-e2e.int.test.ts 외 5곳 |
| P-T53 | ① | 승인 명령 접수(추천 적용 2026-11-09, BUILD_ORDER… | ①는 원장 1행·이력 첫 행 1행·승인 명령 1행이고 같은 답이다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T53 | ② | 승인 명령 접수(추천 적용 2026-11-09, BUILD_ORDER… | ②는 원장 1행·이력 첫 행 1행·승인 명령 1행이고 같은 답이다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T53 | ③ | 승인 명령 접수(추천 적용 2026-11-09, BUILD_ORDER… | ③은 `FAILED_PRECONDITION`과 SEV2 로그 한 줄이고 행이 바뀌지 않는다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T53 | ④ | 승인 명령 접수(추천 적용 2026-11-09, BUILD_ORDER… | ④는 `INVALID_ARGUMENT`이고 쓴 행이 없다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T53 | ⑤ | 승인 명령 접수(추천 적용 2026-11-09, BUILD_ORDER… | ⑤는 계약이 맞아 `IN_PROGRESS`를 받는다. 어떤 로그에도 결제 키·토큰이 없다. 코드 리뷰로 더한 것(추천 적용 2026-11-09… | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ① | 결제 결과 조회 서버(추천 적용 2026-11-09… | ①은 그 사건의 `event_key`·`event_seq`다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ② | 결제 결과 조회 서버(추천 적용 2026-11-09… | ②는 `RESOLVED`를 뺀 마지막 수출 사건이다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ③ | 결제 결과 조회 서버(추천 적용 2026-11-09… | ③은 두 칸이 비어 있다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ④ | 결제 결과 조회 서버(추천 적용 2026-11-09… | ④는 답에 없다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ⑤ | 결제 결과 조회 서버(추천 적용 2026-11-09… | ⑤는 100건이 되고 101건은 `INVALID_ARGUMENT`다. | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |
| P-T54 | ⑥ | 결제 결과 조회 서버(추천 적용 2026-11-09… | ⑥은 `payment (order_id)` 유일 인덱스와 `payment_event` 기본 키를 쓴다. 표가 잠겨 읽지 못하면 문장 시간 한도 400ms… | ID만 | A | 시험: services/payment-svc/test-int/payment-grpc.int.test.ts, services/payment-svc/test-int/payment-process.int.test.ts 외… |

## docs/security/asvs/payment.md

| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| v5.0.0-2.1.1 | — | L1 | 데이터 항목이 기대 구조에 맞는지 확인하는 입력 검증 규칙을 문서에 정의한다. | 자동 시험 | B | 시험: services/purchase-svc/test/end-purchase-session.test.ts, services/purchase-svc/test/read-seat-snapshot.test.ts 외 3곳 |
| v5.0.0-2.1.2 | — | L2 | 여러 데이터 항목을 함께 볼 때의 논리적·문맥적 일관성을 검증하는 방법을 문서에 정의한다. | 자동 시험 | B | 시험: services/purchase-svc/test/seat-layout.test.ts |
| v5.0.0-2.1.3 | — | L2 | 사용자별·시스템 전체의 업무 로직 한도와 검증 기대값을 문서화한다. | ID만 | B | 다른 곳 시험: services/core-svc/test/search.http.test.ts (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-2.2.1 | — | L1 | 입력이 업무·기능 기대를 만족하는지 허용 목록(값·패턴·범위)이나 미리 정한 규칙의 기대 구조·논리 한도로 검증하고, L1은 업무·보안 결정에 쓰는 입력에… | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-deposit.int.test.t… |
| v5.0.0-2.2.2 | — | L1 | 입력 검증을 신뢰할 수 있는 서비스 계층에서 강제하고 클라이언트 검증에 의존하지 않는다. | 자동 시험 | B | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-2.2.3 | — | L2 | 관련 데이터 항목의 조합이 미리 정한 규칙에 맞는지 확인한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test-int/payment-confirm-runner.int… |
| v5.0.0-2.3.1 | — | L1 | 같은 사용자의 업무 흐름을 정해진 순서대로만 처리하고 단계를 건너뛰지 못하게 한다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/consumers.int.test.ts, services/purchase-svc/test-int/order-accepts.int.test.ts 외 24곳 |
| v5.0.0-2.3.2 | — | L2 | 문서화된 업무 로직 한도를 구현해 악용을 막는다. | 자동 시험 | B | 시험: services/admission-ctrl/test/admission-leader.test.ts, services/admission-ctrl/test/aimd.test.ts 외 14곳 |
| v5.0.0-2.3.3 | — | L2 | 업무 로직 수준의 트랜잭션으로 작업이 전부 성공하거나 이전의 올바른 상태로 되돌아가게 한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts, services/payment-svc/test-int/payment-deposit.int… |
| v5.0.0-2.3.4 | — | L2 | 한정 수량 자원이 로직 조작으로 이중 예약되지 않도록 업무 수준 잠금을 쓴다. | 자동 시험 | B | 시험: packages/platform/test-int/idempotency.int.test.ts, packages/platform/test-int/template.int.test.ts |
| v5.0.0-2.4.1 | — | L2 | 데이터 유출, 쓰레기 데이터, 할당량 소진, 레이트 리밋 위반, 서비스 거부, 비싼 자원 남용으로 이어지는 과도한 호출을 막는 자동화 방지 통제를 둔다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-reconciliation.i… |
| v5.0.0-3.2.1 | — | L1 | API 응답·사용자가 올린 파일 등이 잘못된 문맥(HTML 등)으로 그려지지 않게 한다(`Sec-Fetch-*`, CSP sandbox… | 자동 시험 | B | 시험: services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-3.2.2 | — | L1 | HTML이 아니라 글로 보일 내용은 `textContent` 같은 안전한 렌더링 함수로 다룬다. | 자동 시험 | B | 시험: apps/web/src/_pages/queue-verify/model/verify-flow.test.mjs, apps/web/src/_pages/queue-verify/model/view.test.mjs 외… |
| v5.0.0-3.3.1 | — | L1 | 쿠키에 `Secure`를 두고, `__Host-`를 쓰지 않으면 이름에 `__Secure-` 접두사를 붙인다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.2 | — | L2 | 쿠키마다 목적에 맞는 `SameSite`를 둬 CSRF 같은 공격 노출을 줄인다. | ID만 | B | 다른 곳 시험: services/queue-svc/test/edge-first-visit-function.test.ts (영역: apps/web, services/payment-svc… |
| v5.0.0-3.3.3 | — | L2 | 다른 호스트와 공유하도록 설계한 쿠키가 아니면 이름에 `__Host-` 접두사를 쓴다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.3.4 | — | L2 | 스크립트가 읽을 필요 없는 쿠키(세션 토큰 등)는 `HttpOnly`이고 그 값은 `Set-Cookie`로만 보낸다. | 자동 시험 | B | 시험: apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.4.1 | — | L1 | 모든 응답에 HSTS를 둔다(최대 기간 1년 이상, L2부터 하위 도메인 포함). | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-http-rules.test.ts, services/v0-monolith/test/gateway-server.test.ts (영역:… |
| v5.0.0-3.4.2 | — | L1 | CORS `Access-Control-Allow-Origin`은 고정 값으로 두거나 요청의 `Origin`을 신뢰 출처 허용 목록과 대조해 정하고, `*`을… | ID만 | B | 다른 곳 시험: services/queue-svc/test/state-http.test.ts (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-3.4.3 | — | L2 | HTTP 응답에 CSP를 둬 브라우저가 신뢰한 콘텐츠·자원만 싣고 실행하게 하고, 최소한 `object-src 'none'`·`base-uri 'none'`과… | 자동 시험 | B | 시험: apps/web/server/csp-hash-server.test.mjs, apps/web/src/_app/security/page-headers.test.mjs 외 1곳 |
| v5.0.0-3.4.4 | — | L2 | 모든 응답에 `X-Content-Type-Options: nosniff`를 둔다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test-int/seat.int.test.ts, services/v0-monolith/test/gateway-http-rules.test.ts 외 1곳 (영역:… |
| v5.0.0-3.4.5 | — | L2 | 리퍼러 정책을 둬 URL 경로·쿼리 같은 기술적 민감 데이터가 `Referer` 헤더로 제3자 서비스에 새지 않게 한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-3.4.6 | — | L2 | 모든 HTTP 응답에 CSP `frame-ancestors`를 둬 기본적으로 끼워 넣을 수 없게 하고, 필요한 자원만 끼워 넣기를… | 자동 시험 | B | 시험: apps/web/src/_app/security/page-headers.test.mjs |
| v5.0.0-3.5.1 | — | L1 | CORS 사전 요청에 기대지 않는다면 민감 기능 요청이 애플리케이션에서 왔는지 확인한다(위조 방지 토큰, safelisted가 아닌 헤더 요구 등). | 자동 시험 | B | 시험: apps/web/scripts/local-fan-gateway.test.mjs, apps/web/src/features/social-login/server/login-routes.test.mjs |
| v5.0.0-3.5.2 | — | L1 | CORS 사전 요청에 기댄다면 사전 요청을 일으키지 않는 요청으로 그 기능을 부를 수 없게 한다(`Origin`·`Content-Type` 확인 등). | ID만 | B | 다른 곳 시험: apps/partner/src/_pages/seatmap-editor/model/golden.test.mjs, apps/partner/src/_pages/seatmap-editor/model/save… |
| v5.0.0-3.5.3 | — | L1 | 민감 기능은 GET·HEAD·OPTIONS 같은 안전 메서드가 아닌 POST·PUT·PATCH·DELETE 같은 메서드로 부르거나, `Sec-Fetch-*`… | ID만 | B | 다른 곳 시험: services/core-svc/test/seatmap-templates.http.test.ts, services/queue-svc/test/leave-http.test.ts 외 3곳 (영역:… |
| v5.0.0-3.5.4 | — | L2 | 서로 다른 애플리케이션을 다른 호스트 이름에 둬 동일 출처 정책의 제한을 쓴다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-3.5.5 | — | L2 | `postMessage`로 받은 메시지는 출처를 믿을 수 없거나 형식이 틀리면 버린다. | 자동 시험 | B | 시험: apps/web/src/features/identity-verify/flow.test.mjs |
| v5.0.0-3.7.1 | — | L2 | 지원이 끝났거나 안전하지 않은 클라이언트 기술(플러그인, Flash 등)을 쓰지 않는다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-3.7.2 | — | L2 | 애플리케이션이 통제하지 않는 다른 호스트로 자동 이동시킬 때는 허용 목록에 있는 곳으로만 보낸다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test/pg-selection.test.ts |
| v5.0.0-8.2.1 | — | L1 | 기능 접근을 명시적 권한이 있는 호출자로 제한한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/admin-password-change.int.test.ts, services/identity-svc/test/admin-password-change.t… |
| v5.0.0-8.2.2 | — | L1 | 데이터 접근을 그 데이터 항목에 명시적 권한이 있는 호출자로 제한해 IDOR·BOLA를 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test-int/accept-e2e.int.test.ts, services/purchase-svc/test-int/order-holds.int.test.ts 외 20곳 |
| v5.0.0-8.2.3 | — | L2 | 필드 수준 접근을 그 필드에 명시적 권한이 있는 호출자로 제한해 BOPLA를 막는다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-checkout.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 2곳 |
| v5.0.0-11.2.1 | — | L2 | 업계에서 검증된 암호 구현(라이브러리, 하드웨어 가속 구현)을 쓴다. | 자동 시험 | B | 시험: services/payment-svc/test/payment-method-ref.test.ts |
| v5.0.0-11.2.2 | — | L2 | 난수·인증 암호화·MAC·해시 알고리즘, 키 길이, 라운드, 암호와 운용 모드를 언제든 바꿀 수 있고 키·비밀번호 교체와 데이터 재암호화도 할 수 있게… | ID만 | B | 다른 곳 시험: packages/api-client/test/purchase-crypto.test.ts (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-11.2.3 | — | L2 | 모든 암호 기본 요소가 최소 128비트 보안 강도를 갖는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts |
| v5.0.0-11.3.1 | — | L1 | ECB 같은 안전하지 않은 블록 모드와 PKCS#1 v1.5 같은 약한 패딩을 쓰지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/virtual-account-deposit.test.ts |
| v5.0.0-11.3.2 | — | L1 | AES-GCM처럼 승인된 암호와 운용 모드만 쓴다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.test.ts |
| v5.0.0-11.3.3 | — | L2 | 암호화한 데이터를 인증 암호화(또는 승인된 암호와 MAC의 조합)로 무단 변경에서 보호한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test/virtual-account-deposit.test.ts |
| v5.0.0-11.5.1 | — | L2 | 추측되면 안 되는 모든 난수와 문자열은 CSPRNG로 만들고 128비트 이상의 엔트로피를 갖는다(UUID는 이 조건을 만족하지 않는다). | 자동 시험 | B | 시험: services/payment-svc/test/pg-selection.test.ts, services/payment-svc/test/simulator-gateway.test.ts 외 2곳 |
| v5.0.0-12.2.1 | — | L1 | 클라이언트와 외부에 노출된 HTTP 서비스 사이의 모든 연결에 TLS를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | ID만 | B | 다른 곳 시험: services/v0-monolith/test/gateway-config.test.ts, services/v0-monolith/test/gateway-server.test.ts 외 1곳 (영역:… |
| v5.0.0-12.2.2 | — | L1 | 외부에 노출된 서비스는 공인 TLS 인증서를 쓴다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-12.3.1 | — | L2 | 애플리케이션에 들어오고 나가는 모든 연결(모니터링·관리 도구, 원격 접속, 미들웨어, DB, 파트너 시스템, 외부 API 등)에 TLS 같은 암호화 프로토콜을… | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-12.3.2 | — | L2 | TLS 클라이언트가 서버 인증서를 검증한 뒤 통신한다. | 빈칸 | B | 영역: services/payment-svc |
| v5.0.0-12.3.3 | — | L2 | 애플리케이션 안 내부 HTTP 서비스 사이의 모든 연결에 TLS 같은 전송 암호화를 쓰고, 안전하지 않거나 암호화되지 않은 통신으로 돌아가지 않는다. | 빈칸 | B | 영역: services/payment-svc, services/purchase-svc |
| v5.0.0-12.3.4 | — | L2 | 내부 서비스 사이 TLS는 신뢰한 인증서를 쓰고, 내부 발급·자체 서명 인증서를 쓰면 받는 서비스가 지정한 내부 CA와 지정한 자체 서명 인증서만 신뢰하게 한다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-13.1.1 | — | L2 | 애플리케이션의 통신 필요(의존하는 외부 서비스, 사용자가 외부 위치를 줄 수 있는 경우 포함)를 모두 문서화한다. | 자동 시험 | B | 시험: services/purchase-svc/test/consumers.test.ts |
| v5.0.0-13.2.1 | — | L2 | 표준 사용자 세션을 쓰지 않는 백엔드 구성 요소 사이 통신을 개별 서비스 계정·단기 토큰·인증서로 인증하고, 바뀌지 않는 비밀번호·API 키를 쓰지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test-int/portone-gateway.int.test.ts, services/payment-svc/test-int/toss-gateway.int.test.ts 외… |
| v5.0.0-13.2.2 | — | L2 | 백엔드 통신을 최소 권한 계정으로 한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/payment-svc/test/toss-gateway.test.ts |
| v5.0.0-13.2.3 | — | L2 | 서비스 인증에 기본 자격 증명을 쓰지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.2.4 | — | L2 | 애플리케이션이 통신할 수 있는 외부 자원의 허용 목록을 정의한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.2.5 | — | L2 | 서버가 요청을 보내거나 자원을 불러올 수 있는 대상의 허용 목록을 설정한다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-config.test.ts, services/payment-svc/test/toss-config.test.ts |
| v5.0.0-13.3.1 | — | L2 | 키 보관소 같은 비밀 관리 도구로 백엔드 비밀을 안전하게 만들고 저장·접근 통제·폐기하며, 소스 코드와 빌드 산출물에 비밀을 넣지 않고, L3는 HSM 같은… | 자동 시험 | B | 시험: services/payment-svc/test/payment-method-ref.test.ts, services/payment-svc/test/portone-official-schema.test.ts 외 2곳 |
| v5.0.0-13.3.2 | — | L2 | 비밀 자산 접근은 최소 권한 원칙을 따른다. | ID만 | B | 다른 곳 시험: services/admission-ctrl/test/kms-seed-opener.test.ts, services/admission-ctrl/test/seed-reveal.test.ts 외 5곳… |
| v5.0.0-14.1.1 | — | L2 | 애플리케이션이 만들고 처리하는 민감 데이터를 Base64·JWT 본문처럼 인코딩만 된 것까지 모두 찾아, 따라야 할 데이터 보호·개인정보 법규와 표준을 반영한… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts, services/v0-monolith/test-int/gate.int.test.ts 외 4곳… |
| v5.0.0-14.1.2 | — | L2 | 보호 등급마다 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, DB 수준 암호화, 개인정보 보호 기술 같은 보호 요구사항을… | ID만 | B | 다른 곳 시험: services/core-svc/test-int/sale-eligibility.int.test.ts (영역: apps/web, services/payment-svc… |
| v5.0.0-14.2.1 | — | L1 | 민감 데이터는 HTTP 본문이나 헤더로만 서버에 보내고 URL·쿼리 문자열에 넣지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/pg-selection.test.ts |
| v5.0.0-14.2.2 | — | L2 | 민감 데이터가 로드밸런서·애플리케이션 캐시 같은 서버 구성요소에 캐시되지 않게 하거나 사용 뒤 안전하게 지운다. | ID만 | B | 다른 곳 시험: services/core-svc/test-int/seatmap-save.int.test.ts, services/core-svc/test/seatmap-layout.test.ts (영역:… |
| v5.0.0-14.2.3 | — | L2 | 정의된 민감 데이터를 신뢰하지 않는 제3자(사용자 추적 도구 등)에게 보내지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/payment-svc/test/toss-gateway.test.ts |
| v5.0.0-14.2.4 | — | L2 | 보호 등급 문서에 정한 대로 암호화, 무결성 검증, 보존, 로그 기록 방식과 로그 속 민감 데이터 접근 통제, 개인정보 보호 기술을 구현한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test-int/payment-method-ref.int.test… |
| v5.0.0-14.3.1 | — | L1 | 클라이언트나 세션이 끝나면 브라우저 DOM 같은 클라이언트 저장소에서 인증 뒤 받은 데이터를 지우고, 서버에 연결되지 않을 때도 클라이언트가 스스로 지울 수… | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-14.3.2 | — | L2 | 민감 데이터가 브라우저에 캐시되지 않게 `Cache-Control: no-store` 등 캐시 방지 헤더를 둔다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/snapshot-http.test.ts 외 1곳 |
| v5.0.0-14.3.3 | — | L2 | 브라우저 저장소(localStorage, sessionStorage, IndexedDB, 쿠키)에 세션 토큰 말고는 민감 데이터를 두지 않는다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-15.1.1 | — | L1 | 취약한 서드파티 구성요소와 라이브러리 갱신의 위험 기반 조치 기한을 문서에 정한다. | ID만 | B | 다른 곳 시험: tools/ci/vuln-deadline.test.mjs (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-15.1.2 | — | L2 | 모든 서드파티 라이브러리의 목록(SBOM)을 유지하고, 미리 정한 믿을 수 있고 계속 관리되는 저장소에서 오는지 확인한다. | ID만 | B | 다른 곳 시험: tools/ci/sbom-find.test.mjs, tools/web-checks/static/assets.test.mjs (영역: apps/web, services/payment-svc… |
| v5.0.0-15.1.3 | — | L2 | 시간이 오래 걸리거나 자원을 많이 쓰는 기능을 문서에 밝히고, 그 남용으로 가용성을 잃지 않는 방법과 응답 만들기가 호출자의 시간 초과보다 길어지지 않게 하는… | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-channel-limit.in… |
| v5.0.0-15.3.1 | — | L1 | 데이터 객체에서 필요한 필드만 돌려준다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-new-pause.int.test.ts, services/payment-svc/test/payment-grpc.test.ts 외 4곳 |
| v5.0.0-15.3.2 | — | L2 | 백엔드가 외부 URL을 부를 때 의도하지 않은 리디렉션을 따라가지 않는다. | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/payment-svc/test/toss-gateway.test.ts |
| v5.0.0-15.3.3 | — | L2 | 컨트롤러·액션마다 허용 필드를 제한해 대량 할당 공격을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-15.3.4 | — | L2 | 모든 프록시·미들웨어가 사용자의 원래 IP를 최종 사용자가 조작할 수 없는 신뢰 필드로 넘기고, 애플리케이션·웹 서버는 그 값을 로그와 레이트 리밋 같은 보안… | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-15.3.5 | — | L2 | 변수 타입을 확인하고 엄격한 동등·비교 연산을 써서 타입 혼동을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/hold-seats.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-15.3.6 | — | L2 | 프로토타입 오염을 막도록 JavaScript를 작성한다(객체 리터럴 대신 `Set`·`Map` 등). | 자동 시험 | B | 시험: services/payment-svc/test/portone-gateway.test.ts, services/purchase-svc/test/http.test.ts |
| v5.0.0-15.3.7 | — | L2 | HTTP 파라미터 오염 공격을 막는다. | 자동 시험 | B | 시험: services/purchase-svc/test/read-seat-snapshot.test.ts, services/purchase-svc/test/snapshot-http.test.ts |
| v5.0.0-16.2.1 | — | L2 | 로그 항목에 언제, 어디서, 누가, 무엇을 같은 조사용 메타데이터를 넣는다. | ID만 | B | 다른 곳 시험: packages/platform/test/request-log.test.ts, services/core-svc/test-int/production-image.int.test.ts (영역:… |
| v5.0.0-16.2.2 | — | L2 | 로그 구성요소의 시각을 동기화하고 UTC 또는 시간대 오프셋을 쓴다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-16.2.3 | — | L2 | 로그 목록에 적힌 파일과 서비스로만 로그를 저장·전송한다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-16.2.4 | — | L2 | 쓰고 있는 로그 처리기가 로그를 읽고 서로 연관 지을 수 있게 하고, 되도록 공통 로그 형식을 쓴다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-16.2.5 | — | L2 | 민감 데이터는 보호 등급에 따라 로그에 남긴다(자격 증명·결제 정보는 남기지 않고, 일부는 해시·마스킹). | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-confirm-runner.i… |
| v5.0.0-16.3.1 | — | L2 | 성공·실패를 포함한 모든 인증 작업을 기록하고, 인증 방식이나 쓴 인증 요소 같은 메타데이터도 남긴다. | ID만 | B | 다른 곳 시험: services/payment-svc/test-int/payment-webhook.int.test.ts, services/payment-svc/test/payment-webhook.test.ts 외… |
| v5.0.0-16.3.2 | — | L2 | 실패한 인가 시도를 기록하고, L3는 민감 데이터 접근을 포함한 모든 인가 결정을 그 데이터는 빼고 기록한다. | 자동 시험 | B | 시험: services/purchase-svc/test/accept-http.test.ts, services/purchase-svc/test/accept-payment.test.ts 외 1곳 |
| v5.0.0-16.3.3 | — | L2 | 문서화한 보안 이벤트와 보안 통제를 우회하려는 시도를 기록한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-deposit.int.test.ts, services/payment-svc/test-int/payment-reconciliation.int… |
| v5.0.0-16.3.4 | — | L2 | 예상하지 못한 오류와 보안 통제 실패를 기록한다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-confirm-runner.i… |
| v5.0.0-16.5.1 | — | L2 | 예상하지 못한 오류나 보안상 민감한 오류에는 일반 메시지를 돌려주고 내부 정보를 드러내지 않는다. | ID만 | B | 다른 곳 시험: packages/platform/test/problem.test.ts (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-16.5.2 | — | L2 | 외부 자원 접근이 실패해도 안전하게 동작한다. | 자동 시험 | B | 시험: services/identity-svc/test-int/kms-hashers.int.test.ts, services/payment-svc/test-int/payment-call-guard.int.test.ts… |
| v5.0.0-16.5.3 | — | L2 | 예외가 나도 안전하게 실패하고, 검증 오류가 있는데도 거래를 처리하는 fail-open을 막는다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-channel-limit.in… |
| v5.0.0-2.3.5 | — | L3 | 고가치 업무 흐름에는 여러 사람의 승인을 요구한다. | 빈칸 | B | 영역: apps/web, services/payment-svc, services/pg-simulator, services/purchase-svc |
| v5.0.0-3.4.7 | — | L3 | CSP가 위반 보고 위치를 정한다. | ID만 | B | 다른 곳 시험: packages/config/headers/headers.test.mjs (영역: apps/web, services/payment-svc, services/pg-simulator… |
| v5.0.0-13.2.6 | — | L3 | 외부 서비스 연결마다 최대 동시 연결, 한도 도달 시 동작, 연결 타임아웃, 재시도 전략 같은 문서화된 설정을 따른다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-call-guard.int.test.ts, services/payment-svc/test-int/payment-channel-limit.in… |
| v5.0.0-14.2.7 | — | L3 | 민감 정보에 보존 등급을 매기고, 쓸모없어진 데이터를 정한 일정이나 상황에 따라 자동으로 지운다. | 자동 시험 | B | 시험: services/payment-svc/test-int/payment-confirm-runner.int.test.ts, services/payment-svc/test-int/payment-deposit.int… |
