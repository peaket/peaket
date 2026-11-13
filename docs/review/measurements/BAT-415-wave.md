# BAT-415 v2 wave heavy gate(2026-11-13)

- 가지: `wave/lane3-BAT-415-v2`(합치기·푸시 없음)
- 기준: `origin/develop` `47141da9`(R-537 BAT-435 병합)
- 배치: R-539 `2d70cb56`(결제 후 취소 Saga·payment-svc 일반 취소), R-540(HTTP·start/Nest·Redis 취소표·마감 뒤 환급, heavy gate 고침 포함)
- 모델: OpenCode DeepSeek V4.1 Flash 두 줄

## 1. Rebase

`47141da9` 위로 R-539·R-540을 rebase했다. 충돌은 `docs/review/consistency-review.md`와 `docs/review/ledger/README.md` 둘이었고,
정합 점검 표는 R-537·R-539·R-540을 모두 남겼으며 장부 README는 생성물이라 다시 만들었다. 나머지 문서는 자동 병합됐다.

## 2. Docker test-int

| 서비스 | 결과 | 새 시험 |
| --- | --- | --- |
| purchase-svc | **48 files, 1818 passed, 2 skipped** | `cancellation.int.test.ts`(8), `purchase-migration.int.test.ts` 0014(1) |
| payment-svc | **20 files, 467 passed, 2 skipped** | `payment-confirmed-cancel.int.test.ts`(7) |

purchase-svc `cancellation.int.test.ts`는 실제 PostgreSQL 18에 purchase·ticket·payment 데이터베이스를 따로 만들고
`0014_order_cancellation`·ticket `0000`·payment `0014`를 적용한다. 실제 ticket-svc `CancelTickets` gRPC와 실제 payment-svc
`CancelPayment` gRPC(원장·`CancelConfirmedPayment`·`GetPayment` 처리기)를 띄우고, Valkey 8.1에서 취소표 Lua의
`s:{event:E}:bitmap`·`secver`·구역 Pub/Sub을 확인한다. 취소 Saga·공제·FRAUD 0원·`refund_due_at`·입장 기록 마감 뒤 환급 정비 일을
한 파일에서 본다. payment-svc `payment-confirmed-cancel.int.test.ts`는 실제 PostgreSQL에서 부분·전액 취소, 같은 취소 ID 재요청,
`CANCEL_PENDING`·`UNKNOWN` 원장 무변경, `cancelled_amount` 누적·CHECK를 본다.

전체 실행에서 이번 배치와 무관한 기존 시험 두 개가 자원 경합으로 한 번씩 실패해 각각 단독 재실행으로 통과를 확인했다
(`pin-failed-mark.int.test.ts`의 스냅샷 `chk` 1 차이, `payment-entry-pause-judge.int.test.ts`의 `PaymentDeadlineError`).
최종 전체 재실행은 purchase-svc 1818 통과, payment-svc 467 통과다.

## 3. 변이(등급 A)

변이는 잠시 넣고 시험을 돌린 뒤 `git checkout`으로 되돌렸다(커밋에 남기지 않는다). **14개 모두 잡힘, 놓침 0.**

| # | 변이 | 시험 | 결과 |
| --- | --- | --- | --- |
| A | 취소 Saga가 `REQUESTED` 대신 `REFUND_PENDING`을 씀 | `test/cancel-ticket.test.ts` | 잡힘 |
| B | 견적의 입장 시작 판정을 빼고 ticket-svc 결과만 씀(경계) | `test/cancel-ticket.test.ts` | 잡힘 |
| C | 결제사 `CANCELLED` 판정을 반전(되돌림) | `test/cancel-ticket.test.ts` | 잡힘 |
| D | 7일 전 공제율 10%를 0%로 | `test/refund-policy.test.ts` | 잡힘 |
| E | 7일 전 경계를 8일 전부터로 | `test/refund-policy.test.ts` | 잡힘 |
| F | 환급액에서 공제를 빼지 않음(되돌림) | `test/refund-policy.test.ts` | 잡힘 |
| G | `FRAUD`를 공제 대상에서 뺌 | `test/cancel-ticket.test.ts` | 잡힘 |
| H | Redis 비트맵을 끄지 않고 1로 씀 | `test-int/cancellation.int.test.ts` | 잡힘 |
| I | 취소표 Lua가 `secver`를 올리지 않음(경계) | `test-int/cancellation.int.test.ts` | 잡힘 |
| J | 결제사 멱등키에서 취소 ID를 뺌 | `test/confirmed-cancel.test.ts` | 잡힘 |
| K | `cancelled_amount`를 더하지 않고 덮어씀 | `test-int/payment-confirmed-cancel.int.test.ts` | 잡힘 |
| L | 입장 기록 마감 상한을 50시간에서 49시간으로(경계) | `test-int/cancellation.int.test.ts` | 잡힘 |
| M | 입장 기록 마감 상한을 24시간으로 되돌림 | `test-int/cancellation.int.test.ts` | 잡힘 |
| N | `VOIDED` 취소 재요청을 `REPLAYED`로 되살림 | `test/cancel-ticket.test.ts` | 잡힘 |

## 4. 4관점 리뷰

| 관점 | 본 것 | 결과 |
| --- | --- | --- |
| 보안 | 재인증 닫힘, 구매 서명, 멱등키, 쓰기 벌크헤드, 로그의 계좌·결제 참조 | 중간 1 고침(취소 POST `@Bulkhead(WRITE_BULKHEAD)` 누락) |
| 정합 | 견적·Saga·ticket-svc·payment-svc의 입장/공연 시작 판정, `refund_due_at`, `VOIDED`, OpenAPI·생성물 | 중간 4 고침(입장 시작 판정, `REFUND_PENDING` 재요청, `VOIDED`, OpenAPI 403/404·생성물) |
| 시험 | 단위·test-int·변이가 같은 계약을 보는지, 실제 gRPC·Redis·DB | 중간 1 고침(입장 기록 마감 상한 24→50시간) |
| 운영 | 시작 조립, gRPC 클라이언트 종료, 정비 일 배치·재시도, Redis 수명 | 중간 1 고침(start/relay gRPC 클라이언트 종료) |

**높음 0, 중간 7(모두 고침).** 남은 것은 아래 5번의 known gap이다.

## 5. CI 로컬 등가

| 검사 | 결과 |
| --- | --- |
| purchase-svc typecheck | 통과 |
| payment-svc typecheck | 통과 |
| `pnpm lint` | 통과 |
| purchase-svc 단위 | 3781 통과 |
| payment-svc 단위 | 2916 통과 |
| purchase-svc test-int | 1818 통과(2 skipped) |
| payment-svc test-int | 467 통과(2 skipped) |
| doc-check | 오류 0, 경고 4(기존) |
| ledger `--batch BAT-415 --require` | 통과 |
| trace-check `R-T3,R-T4` | 통과 |
| `records --check` | 통과(기존 R-374·R-473 경고만) |
| contracts `gen:check` | 통과 |
| api-client typecheck·test | 113 통과 |
| 변이 | 14/14 잡힘 |

## 6. 브라우저 확인

화면 변경이 없다. 이 배치는 purchase-svc·payment-svc의 HTTP/gRPC·DB·Redis와 정비 일만 바꾸고 `apps/web`·화면 계약을 바꾸지 않았다.
그래서 브라우저 확인을 생략한다.

## 7. 남은 문제(known gap)

1. **재인증 토큰 확인**: identity의 재인증 토큰 검증 어댑터가 없어 취소 HTTP는 늘 403 `reauth-required`로 닫혀 있다. 견적은 열려 있다.
2. **부정 예매 운영자 취소**: ticket-svc `OperatorCancelTickets`가 없어 `FRAUD` 0원 계산만 있고 운영자 취소 경로는 연결하지 못했다.
3. **입장 기록 마감**: core-svc `event.entry_closed_at`이 purchase-svc에 오지 않아 `refund_due_at`을 공연 시작 + 50시간(공연 24 + 역할 유효 끝 2 + 미보고 24)의 보수적 상한으로 둔다. 입장 기록이 있는 취소 접수 티켓을 CS 이상 표시로 보내는 판정도 ticket-svc 입장 기록 계약이 생기면 이어야 한다.
4. **가상계좌 환급**: payment `CancelPayment` proto에 환불 계좌 칸이 없고 `order_cancellation`에도 저장하지 않아(POL-014) 지금은 카드 결제만 환급한다. 가상계좌는 실행 때 계좌를 받는 알림 경로가 필요하다.
5. **`purchase_order.status` 전이**: 취소 행은 `order_cancellation`에 쓰지만 주문 상태를 T22~T24(`PARTIALLY_REFUNDED`·`REFUNDED`)로 바꾸지 않는다. 주문 이력·화면 정합을 위해 주문 전이 함수와 Outbox를 연결해야 한다.
6. **좌석맵 판 변경**: 취소 시점의 좌석맵에 좌석이 없으면 `DrizzleSeatReturns`가 좌석 되돌리기를 시작하지 못한다. 판이 바뀌어도 DB `seat_sale`은 되돌리고 Redis 알림만 건너뛰는 보완이 필요하다.
7. **CS 무효 경합**: `RefundAfterEntry`가 결제사를 부른 뒤 `updateStatus`를 조건 없이 써서, 그 사이 CS가 `VOIDED`로 끝낸 취소를 `REFUNDED`로 덮을 수 있다. `status = 'REQUESTED'` 조건부 갱신이 필요하다.
