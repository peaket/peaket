# ADR-0280: 회차 취소 확정은 판매를 먼저 멈추고, 좌석을 다시 팔지 않으며, 늦게 끝난 주문까지 쓸어 담는다(2026-11-16)

- **상태**: 채택(2026-11-16, 추천 적용. 웨이브 8 갈래 3 BAT-420 계획 담당이 정본 빈칸으로 정했다. 방향은 docs/planning/03 §2.11 T8 '취소 확정(회차 CANCELLED)'과 ADR-0123 결정 3 그대로이고, 그 안의 집행 세부를 정한다)
- **관련**: [ADR-0123](0123-sale-review-suspended-takedown-resume-or-cancel.md)(판매 중지와 제어 상태), [ADR-0046](0046-cancel-transfer-refund-approvals.md)(회차 취소와 2인 확정), [ADR-0103](0103-control-as-state-startup-sync-broadcast-topics-compacted-settings.md), [docs/features/transfer-refund.md](../features/transfer-refund.md) §5 '확정 때 판매 멈춤·좌석·늦게 끝난 주문', [docs/data.md](../data.md) §5, [docs/api/guidelines.md](../api/guidelines.md) §8.1, [docs/review/plans/BAT-420.md](../review/plans/BAT-420.md)
- **관련 ID**: R-T37, R-T24, FR-055, POL-032, BUILD_ORDER GAT-110

## 맥락

- 2026-11-15까지의 회차 취소 확정(ops-svc `approve`, R-592)은 purchase-svc `StartEventRefund`만 불렀다. 그 회차의 판매는 그대로 열려 있었다. 대상 표는 시작할 때 한 번만 골랐다.
- 그래서 세 가지 틈이 있었다.
  - 확정 뒤에도 그 회차에 새 홀드·결제가 들어올 수 있다. 그 주문은 대상 목록에 없어 환급되지 않는다.
  - 확정 직전에 결제를 접수한 주문, 입금 대기에서 나중에 입금된 주문도 대상 목록 밖이다.
  - 일괄 환불은 예매 취소 Saga를 그대로 불러 좌석을 취소표로 되돌렸다(`seat_sale` RETURNED, Redis 비트맵 빈 좌석, 취소표 변경분). 판매가 열려 있으면 취소된 회차의 좌석이 다시 팔린다.
- 회차를 core에 CANCELLED로 쓰는 일(T8)은 검색 읽기 모델과 같은 트랜잭션이어야 한다(search SR-T8 ③). 그 검색 표(갈래 2 BAT-165, 웨이브 7 가지에만 있다)가 아직 develop에 없어 지금은 그 일을 할 수 없고, 그 일만으로는 판매 경로(purchase-svc 홀드·결제 접수)도 바로 막히지 않는다.

## 결정

1. **확정은 판매를 먼저 멈춘다.** 회차 취소(CANCEL) 확정은 일괄 환불을 시작하기 전에 ops-svc가 그 회차에 판매 중지 집행(ADR-0123 결정 3과 같은 길: purchase-svc `sale_control.suspended`·좌석 제어 사본 → queue-svc 사본)을 건다. `commandId`와 `suspensionRef`는 회차 취소 요청 ID, 사유는 `EVENT_CANCELLATION`이다. 받는 쪽은 같은 명령 ID에 멱등이다. 멈춤이 실패하면 확정하지 않는다(503 `sale-stop-unavailable`, PENDING_APPROVAL 그대로). 연기(POSTPONE)는 판매를 멈추지 않는다.
2. **판매 재개를 막는다.** 그 회차에 CANCEL 요청이 APPROVED·RUNNING·PAUSED·COMPLETED면 운영 명령 `SALE_RESUME`은 만들 때 409 `event-cancelled`이고, 실행 때 다시 보아 `FAILED`(받는 쪽 호출 없음)다. 판매 중지 표시를 회차 취소와 함께 쓰므로, 판매 재개가 취소된 회차를 다시 열지 못하게 하는 것이다.
3. **좌석을 다시 팔지 않는다.** 회차 취소 환급은 좌석을 취소표로 되돌리지 않는다. `seat_sale` SOLD, 좌석 Redis 비트맵, 취소표 변경분, 1인 한도를 바꾸지 않는다. 연기 신청 환급은 지금처럼 되돌린다(바뀐 일시로 다시 판다).
4. **늦게 끝난 주문을 쓸어 담는다.** 일괄 환불 실행기(10초 [가정] 틱)가 RUNNING·PAUSED인 CANCEL 요청마다 대상을 다시 골라 항목이 없는 표를 더한다. 취소 ID가 요청 ID와 표 ID에서 정해지는 값이라 여러 번 더해도 하나다. 새로 더한 주문에도 확정 알림을 주문마다 한 번 남긴다.
5. **끝나지 않은 주문이 있으면 끝내지 않는다.** 그 회차에 끝나지 않은 주문(`CREATED`·`AUTHENTICATED`·`ACCEPTED`·`RESERVED`·`AWAITING_DEPOSIT`·`APPROVED`·`UNKNOWN`)이 남아 있는 동안 요청은 COMPLETED로 가지 않는다. 그래서 COMPLETED에서 RUNNING으로 되돌아가는 전이(상태도에 없다)를 만들지 않는다. 입금 대기·발권 대기 주문을 확정 때 바로 끝내는 일은 PRF-173이다.
6. **core 회차 상태와 검색은 뒤에 붙인다.** core-svc에 회차를 CANCELLED(연기면 POSTPONED와 바뀐 시작)로 쓰고 같은 트랜잭션에서 검색 읽기 모델을 고치는 일은 갈래 2 BAT-165의 검색 표가 develop에 합쳐진 뒤 BUILD_ORDER GAT-110이 한다. 그 전에는 결정 1이 판매를 막는다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 | 다시 볼 조건 |
| --- | --- | --- | --- | --- |
| 판매 중지 표시(`suspended`)를 같이 쓰고 판매 재개를 막는다(이 결정) | 이미 있는 집행 길(purchase·queue·admission-ctrl이 읽는 칸, 홀드 Lua의 423)을 그대로 쓴다. 표·키·Lua를 바꾸지 않는다 | 판매 중지와 회차 취소가 한 표시를 나눠 써서, 판매 재개 쪽에 막는 규칙이 하나 는다 | 고른다 | 판매 중지와 회차 취소를 화면·감사에서 따로 보여야 할 일이 생기면 따로 된 표시(`cancelled`)를 둔다 |
| 회차 취소 전용 표시를 새로 둔다 | 뜻이 섞이지 않는다 | purchase `sale_control`·좌석 제어 Hash·queue 사본·홀드 Lua·admission-ctrl 읽기를 모두 바꿔야 한다 | 쓰지 않는다 | 위와 같다 |
| core 회차 CANCELLED만으로 판매를 막는다 | 상태의 정본 한 곳 | 판매 설정 사본이 purchase에 닿는 데 시간이 걸리고, 검색 표(갈래 2 BAT-165)가 아직 없어 지금 할 수 없다 | 결정 6으로 뒤에 붙인다 | — |
| 대상을 시작 때 한 번만 고른다(이전) | 단순하다 | 늦게 끝난 결제가 환급에서 빠진다 | 쓰지 않는다 | — |
| 일괄 환불도 좌석을 되돌린다(이전) | 예매 취소 Saga를 그대로 쓴다 | 판매가 열려 있으면 취소된 회차 좌석이 다시 팔린다 | 쓰지 않는다 | — |

## 결과

- 확정 뒤 그 회차에 새로 팔리는 표가 없고, 확정 전후로 결제가 끝난 표도 모두 환급 대상이 된다.
- 회차 취소 요청은 그 회차의 결제·입금 대기가 끝날 때까지 COMPLETED가 늦어질 수 있다(입금 기한만큼). 진행률은 그동안에도 맞다.
- 판매 중지 표시를 회차 취소가 함께 쓰므로, 판매 재개 명령에 막는 규칙이 붙는다.

## 되돌릴 조건

- core 회차 CANCELLED와 판매 설정 사본 반영이 확정과 같은 때에 닿게 되면(결정 6 뒤), 결정 1의 판매 중지 표시를 회차 상태 반영으로 바꿀지 다시 본다.
