# BAT-420 GAT-090 wave heavy gate(2026-11-13~14)

- 가지: `wave/lane3-BAT-420`(합치기·푸시 없음)
- 기준: `origin/develop` `e772c9d9`(R-545 BAT-620 병합)
- 배치: R-547(부분 환불 주문 상태·환급 재시도·CS 실패 표시)
- 모델: OpenCode DeepSeek V4.1 Flash 두 줄

## 1. Rebase

`e772c9d9` 위로 R-547을 rebase했다. 충돌은 `docs/00-summary.md`·`docs/review/consistency-review.md` 둘이었고 R-545와 R-547을 모두 남겼다.
`docs/review/ledger/*`는 `node tools/ci/ledger.mjs`로 재생성했다(항목 3650, 빈칸 1034, ID만 1130, 미검증 4).

## 2. Docker test-int

| 검사 | 결과 |
| --- | --- |
| purchase-svc 전체 test-int | **48 files, 1823 passed, 2 skipped** |
| `cancellation.int.test.ts` | 12 passed |
| `purchase-migration.int.test.ts` | 79 passed(0015 포함) |

`cancellation.int.test.ts`는 실제 PostgreSQL 18에 purchase·ticket·payment DB를 따로 만들고 `0015_order_cancellation_refund_retry`를 적용한다.
부분 환불 T22·전액 T24, `refund_attempts`·`next_refund_at`·`refund_failed_at`, `cancellation-refund-retry`의 1분→6시간 재시도,
같은 `cancel-{cancellationId}` 멱등키, 업무 거절·5회 소진의 CS 실패 표시, 주문 이력·Outbox(T22)를 확인한다.
실제 ticket-svc `CancelTickets`·payment-svc `CancelPayment` gRPC와 Valkey 8.1 취소표 Lua도 함께 돈다.

## 3. 변이(등급 A)

변이는 잠시 넣고 시험을 돌린 뒤 `git checkout`으로 되돌렸다. **13개 모두 잡힘, 놓침 0.**

| # | 변이 | 시험 | 결과 |
| --- | --- | --- | --- |
| A | 부분/전액 판정이 환급 완료를 보지 않음 | `test/cancellation-order-status.test.ts` | 잡힘 |
| B | 환급 수 경계 `>=`를 `>`로 | `test/cancellation-order-status.test.ts` | 잡힘 |
| C | T24/T22 전이 반전(되돌림) | `test/cancellation-order-status.test.ts` | 잡힘 |
| D | 재시도 1분을 61초로 | `test/refund-after-entry.test.ts` | 잡힘 |
| E | 재시도 상한 `>=`를 `>`로(경계) | `test/refund-after-entry.test.ts` | 잡힘 |
| F | 업무 거절을 즉시 실패로 보지 않음 | `test/refund-after-entry.test.ts` | 잡힘 |
| G | 결제사 멱등키에서 취소 ID 제거 | `test/confirmed-cancel.test.ts` | 잡힘 |
| H | 취소 생성 때 주문 전이 제거 | `test-int/cancellation.int.test.ts` | 잡힘 |
| I | 환급 완료 때 주문 전이 제거(되돌림) | `test-int/cancellation.int.test.ts` | 잡힘 |
| J | `refund_failed_at` 행을 실행기가 건너뛰지 않음 | `test-int/cancellation.int.test.ts` | 잡힘 |
| K | 실행기 `CANCELLED` 판정 반전(되돌림) | `test/refund-after-entry.test.ts` | 잡힘 |
| L | 재시도 예약 1분을 1초로 | `test/cancel-ticket.test.ts` | 잡힘 |
| M | `refund_failed_at`을 비움 | `test-int/cancellation.int.test.ts` | 잡힘 |

## 4. 4관점 리뷰

**높음 0, 중간 6(모두 고침).**

| 관점 | finding | 고침 |
| --- | --- | --- |
| 보안 | 같은 취소 ID 재요청을 결제자 확인 전에 처리해 다른 계정에 환급액이 보일 수 있었다 | 결제자 확인을 먼저 하고, 취소 ID의 주문·티켓이 다르면 CONFLICT |
| 정합 | 결제가 끝나기 전에 주문을 REFUNDED로 바꿔, 다른 취소 ID가 ALREADY_ENDED가 됐다 | 환급이 끝나기 전에는 PARTIALLY_REFUNDED, `updateStatus(REFUNDED)`가 T23/T24로 마무리 |
| 정합 | 주문이 REFUNDED가 된 뒤 같은 취소 ID 재요청이 견적에서 막혔다 | 기존 취소를 견적·티켓 취소 전에 읽어 REPLAYED |
| 정합 | `create`와 `updateStatus`의 잠금 차례가 달라 교착 위험 | 둘 다 주문 행을 먼저 잠그게 통일 |
| 운영 | 재시도 간격은 1분인데 정비 일은 하루 한 번이라 간격이 의미 없었다 | `RefundRetryLoop`를 릴레이 리더에 넣어 1분마다 실행 |
| 시험 | 주문 이력·Outbox 변이를 처음 시험이 놓쳤다 | REFUND_PENDING 직후 T22 이력·Outbox 단언 추가 |

## 5. CI 로컬 등가

| 검사 | 결과 |
| --- | --- |
| purchase-svc typecheck | 통과 |
| payment-svc typecheck | 통과 |
| `pnpm lint` | 통과 |
| purchase-svc 단위 | **3792 통과** |
| purchase-svc test-int | **1823 통과**(2 skipped) |
| doc-check | 오류 0, 경고 4(기존) |
| ledger `--check` | 통과 |
| records `--check` | 통과(기존 R-374·R-473 경고만) |
| contracts `gen:check` | 통과 |
| api-client typecheck·test | 113 통과 |
| 변이 | 13/13 잡힘 |

## 6. 브라우저 확인

화면 변경이 없다. 이 배치는 purchase-svc의 DB·환급 실행기·릴레이 반복만 바꾸고 `apps/web`·화면 계약을 바꾸지 않았다.
그래서 브라우저 확인을 생략한다.

## 7. 장부·trace-check known gap

`ledger --batch BAT-420 --require`는 **229개 항목 중 빈칸 103, ID만 103**으로 실패한다. 이는 GAT-110 하나 때문이 아니다.
- `R-T24`는 GAT-110(회차 취소·일괄 환불) 미구현으로 빈칸이다.
- `I-T43`은 장부에서 이미 `다른 단계`(BOT-030·BOT-035)로 분류돼 실패 원인이 아니다.
- 나머지 빈칸은 `R-T1`·`R-T2`·`R-T5`·`R-T6`·`R-T7`·`R-T29`와 ASVS 16.x 등 BAT-420 묶음 범위의 다른 미구현 시나리오다.
- 이 배치가 연 GAT-090은 `GAT090_` 이름의 단위·test-int로 덮였지만, R-T24/I-T43 trace ID에 태그되지 않아 batch 자동 시험 수(2: R-T3·R-T4)에는 잡히지 않는다.
- `trace-check R-T24,I-T43`은 두 ID의 시험이 없어 실패한다. R-T24는 GAT-110, I-T43은 다른 단계다.

## 8. 남은 문제

1. **GAT-110**: ops-svc(저장소에 없음)·GAT-120 일괄 환불 선행 부재.
2. **실제 CS 처리함 건**: `support.cases-requested`의 `REFUND_FAILED` 계약이 없어 `refund_failed_at`·경보 로그까지만.
3. **가상계좌 환급 계좌**: payment `CancelPayment` proto에 계좌 칸이 없고 `order_cancellation`에도 저장하지 않는다(POL-014).
4. **VOIDED 뒤 주문 상태**: CS가 취소를 VOIDED로 끝내도 주문을 CONFIRMED로 되돌리는 전이가 없다.
5. **R-T24·I-T43**: GAT-110·탈퇴 단계라 이 배치에 시험이 없다.
