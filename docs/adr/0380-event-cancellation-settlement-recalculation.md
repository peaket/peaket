# ADR-0380: 회차 취소·연기 환급의 정산 다시 계산 — 확정 때 지급을 막고, 일괄 환불이 끝나면 새 판으로 한 번 다시 계산한다(2026-11-23)

- **상태**: 채택(2026-11-23, 감독 결정, BUILD_ORDER F-07-8 계획 `docs/review/plans/F-07-8.md` 'ADR 필요'의 결정안 D-1~D-7을 받아들이고 Q-02를 결정 8로 정함).
- **관련**: [ADR-0046](0046-cancel-transfer-refund-approvals.md), [ADR-0197](0197-fraud-cancellation-call-settlement-screen-contract-additions.md), [ADR-0285](0285-mesh-port-allow-source-generated-policies.md), [ADR-0317](0317-compensation-transfer-path-and-advance-receivable.md), [ADR-0368](0368-settlement-statement-notify-dispute-adjust-flow.md), ADR 0369·0370(F-07-6·F-07-7 가지, 아직 develop에 없음), [docs/features/settlement.md](../features/settlement.md) §4.1·§4.4·§7·§12, [docs/features/transfer-refund.md](../features/transfer-refund.md) §5, [docs/planning/03-policies-glossary.md](../planning/03-policies-glossary.md) §2.12
- **관련 ID**: FR-055, FR-062, POL-032, J-T11, J-T23

## 맥락

- 정본은 회차 취소·연기의 환급이 생기면 정산서를 판본 +1 새 판으로 다시 계산하고 옛 판을 `SUPERSEDED`로 남긴다고 정했다(settlement §4.1 '다시 계산', §12 첫 두 줄, 03 §2.12 T10·T14~T17). 그러나 **언제** 다시 계산하는지, **누가** payment-svc에 회차 취소를 알리는지는 정하지 않았다.
- 2026-11-23 코드에서 payment-svc는 회차 취소를 알 길이 없다(Kafka 소비자 없음, 받는 내부 경로 없음). `calculateEvent`는 있는 정산서를 그대로 돌려주고 판을 올리지 않는다(F-07-5 계획 G-13).
- 확정 즉시 다시 계산하면 아직 결제사가 취소하지 않은 결제가 판매 대금에 그대로 남아 새 판도 틀리고, 그 뒤의 환급은 모두 계산 뒤 환급(미수금)이 되어 다시 계산하는 뜻이 없다. 반대로 환급이 끝날 때까지 아무것도 하지 않으면 그동안 확정·지급 묶음이 옛 금액으로 돈을 보낸다.
- 감액 수기 조정으로 지급액이 0 아래가 된 정산서는 확정 때 `CARRIED_OVER`로 끝나고 `NEGATIVE_STATEMENT` 미수금을 만든다(ADR-0368 결정 10). 그 정산서를 다시 계산하면 옛 판의 미수금과 새 판의 결과가 같은 돈을 두 번 잡을 수 있다.
- 대사 불일치로 계산에서 뺀 결제가 나중에 풀리면 지급 전이면 조정 행, 지급 뒤면 다음 정산서 조정이나 미수금으로 넣는다고 했지만(settlement §4.1), 수기 조정은 2인 승인이다(§4.3, ADR-0368 결정 7·8).

## 결정

1. **보류 시점(D-1)**: 회차 취소(CANCEL)·연기(POSTPONE) 확정이 일괄 환불 요청을 만든(`StartEventRefund` 커밋) 직후 payment-svc가 그 회차의 정산서 지급을 막는다. 다시 계산은 그 일괄 환불이 끝난 뒤 정산서마다 한 번 한다.
2. **부르는 길(D-2)**: 일괄 환불의 주인인 purchase-svc가 payment-svc 정산 내부 HTTP 두 경로를 부른다. `PUT /internal/v1/settlements/event-recalculations/{requestId}`(본문 `eventId`·`kind`·`confirmedAt`, 보류 열기)와 `POST /internal/v1/settlements/event-recalculations/{requestId}/completion`(본문 `completedAt`·`partial`, 다시 계산)이다. 서비스 사이 공유 토큰(`x-peaket-internal-token`)이 없거나 틀리면 401이고, purchase-svc는 이미 payment-svc 내부 HTTP의 부르는 쪽(ADR-0285 결정 9)이라 메시 허용이 늘지 않는다. 같은 요청 ID는 멱등이고, 같은 ID에 다른 회차·종류는 409 `recalculation-conflict`다. 부르기 실패는 확정·환급을 막지 않는다. purchase-svc는 보낸 시각 칸(`settlement_hold_sent_at`·`settlement_completion_sent_at`)을 비운 채 두고 일괄 환불 실행기 틱이 1분 → 5분 → 15분, 그 뒤 15분마다 [가정] 다시 부른다. 완료는 보류 열기가 성공한 뒤에만 부른다. payment-svc에 처음으로 Kafka 소비자를 두는 안과 ops-svc가 진행률을 읽어 부르는 안은 부품이 늘어 고르지 않았다.
3. **끝의 뜻(D-3)**: 일괄 환불 요청의 `COMPLETED`(모든 항목이 끝 상태이고 그 회차에 끝나지 않은 주문이 없음, transfer-refund §5)다. 연기는 신청 창이 닫히고 신청 건 환급이 끝난 `COMPLETED`다. 확정 + 3영업일 [가정](환급 기한과 같은 값)이 지나도 `COMPLETED`가 아니면(계좌 대기 등) 그때까지의 환급으로 다시 계산하고(`partial: true`), 그 뒤의 환급은 결정 5의 미수금이 된다. 남은 환급이 정산을 끝없이 막지 않게 하려는 것이다.
4. **상태별 처리(D-4)**: 보류를 열 때 그 회차의 살아 있는(`SUPERSEDED`가 아닌) 정산서를 모든 결제사·상점에서 다음처럼 다룬다. 정산서마다 조건부 전이(ADR-0368 결정 2)와 한 트랜잭션이다.
   - `NOTIFIED`·`DISPUTED`: 그대로 둔다(자동 확정은 계속 돈다). 지급 묶음 판정이 다시 계산 대기 회차의 `CONFIRMED`를 `HELD`(새 보류 사유 `RECALCULATION`)로 보낸다.
   - `CONFIRMED`이고 묶음에 묶이지 않음: `HELD`(`RECALCULATION`)와 `PAYOUT_HELD`.
   - `CONFIRMED`이고 묶음에 묶였지만 결제사 접수 전(F-07-6 계획 E-01): 묶음에서 빼고(묶음 합계·건수 다시 셈), 그 정산서의 상계를 되돌린 뒤(`OFFSET`마다 `REVERSAL` 한 줄, 미수금 `remaining` 되살림, `OPEN`) `HELD`(`RECALCULATION`)·`PAYOUT_HELD`.
   - `SCHEDULED`이고 토스페이먼츠 지급 건이 모두 `REQUESTED`: 예약지급을 취소하고(T10) 위와 같이 상계를 되돌린다. 포트원 실행 전이면 수기 정산건을 취소하고(T10) 같다. 결제사 취소가 실패하면 그 정산서는 그대로 두고 30분 tick이 다시 한다.
   - 지급 건 하나라도 `IN_PROGRESS`·`COMPLETED`이거나 `PAID`·`FAILED`: 다시 계산하지 않는다(§12 둘째 줄). 그 정산서의 환급은 결정 5의 미수금이다.
   - `HELD`(다른 사유): 사유를 바꾸지 않고 다시 계산 대상에 둔다(T17).
   - `CARRIED_OVER`: 그대로 두고 다시 계산 대상에 둔다(결정 8).
5. **미수금과의 경계(D-5)**: 다시 계산 대기인 회차의 환급은 미수금으로 잡지 않고 다시 계산이 새 판의 '환급'에 넣는다. 결정 4에서 다시 계산하지 않는 정산서와, 다시 계산이 끝난 뒤의 환급은 계산 뒤 환급의 미수금(settlement §7, `REFUND_AFTER_PAYOUT`, 수수료 몫·부가세를 뺌, 근거 `refund:{정산서 ID}:{결제 ID}:{누적 환급액}` 부분 유일)이다. 그래서 한 환급이 새 판의 환급과 미수금에 두 번 들지 않는다. 계산 뒤 환급의 미수금은 정산 일꾼 30분 tick이 결제 취소의 끝난 시각으로 훑어 만든다.
6. **새 판과 옛 판(D-6)**: 다시 계산은 정산서마다 한 트랜잭션에서 그 결제사·상점의 결제를 다시 읽어 판 = 옛 판 + 1·`supersedes_id` = 옛 판·새 계산 원본 목록(`statement_source`)·옛 판의 고정 수수료율로 새 판을 `CALCULATED`로 넣고 바로 `NOTIFIED`(이의 기한 = 다시 계산 시각 + 2영업일, `STATEMENT_NOTIFIED`)로 바꾸며, 옛 판은 금액 칸 그대로 `SUPERSEDED`(감사는 출발 상태에 맞는 T14~T17·T19)로 둔다. 옛 판에 적용된 수기 조정의 합은 새 판으로 옮기고, 적용 전 조정은 무효로 해 승인을 다시 받게 하며, 열린 이의는 결과 `SUPERSEDED`로 닫는다(파트너는 새 판에 다시 낸다). 정산서가 아직 없는 회차(06시 계산 전)는 완료가 아무것도 하지 않고, 나중의 계산이 모든 환급을 넣는다.
7. **대사 미완 결제 풀림(D-7)**: 계산에서 뺀 결제의 대사 차이가 풀리면 정산 일꾼이 그 결제의 순액(판매 대금 − 환급 − 수수료 몫 − 부가세, 결정 5와 같은 버림)을 셈해, 지급 전 정산서면 그 정산서에, 지급 뒤면 같은 파트너·같은 결제사의 다음 지급 전 정산서에 조정 제안 CS 건(`SETTLEMENT_ADJUSTMENT_SUGGESTED` [가정 이름])을 연다. 조정 행은 지금처럼 2인 승인 뒤 적용한다(§4.3). 정산 금액을 바꾸는 길을 승인 없이 열지 않는다.
8. **옛 판의 음수 미수금은 되돌리고 새 판에서 다시 잡는다(Q-02)**: `CARRIED_OVER` 옛 판에 `NEGATIVE_STATEMENT` 미수금(근거 `negative-statement:{옛 판 ID}`)이 있으면, 다시 계산 트랜잭션에서 그 미수금을 행 잠금으로 읽어 남은 금액만큼 이동 `SUPERSEDED`(새 이동 종류, 다시 계산으로 닫음) 한 줄을 더하고 `CLOSED`로 둔다. 그 미수금이 이미 다른 정산서 상계·보증으로 돌려받은 금액(금액 − 남은 금액)은 새 판의 조정 합에 더한다(근거 `negative-recovered:{미수금 ID}`). 새 판의 지급액이 확정 때 0 아래면 ADR-0368 결정 10대로 새 판 ID의 `NEGATIVE_STATEMENT`를 새로 만든다. 그래서 다시 계산으로 바뀐 것이 없으면 새 미수금 = 옛 남은 금액이고, 같은 돈이 옛 판·새 판에 두 번 잡히지 않는다. `CARRIED_OVER` 옛 판의 상계(`OFFSET`)는 결정 4와 같이 `REVERSAL`로 되돌린다. 상태도에 `CarriedOver → Calculated`(T19, 다시 계산)를 더한다.

## 결과

- 좋아지는 점: 회차 취소·연기의 환급이 이미 알린 정산서에 판으로 남고, 그동안 옛 금액으로 돈이 나가지 않는다. 한 환급이 새 판과 미수금에 두 번 들지 않고, 음수 미수금도 두 번 잡히지 않는다. 기존 부르는 쪽 목록 안의 내부 HTTP라 새 부품이 없다.
- 잃는 점: 일괄 환불이 끝날 때까지(길면 확정 + 3영업일) 그 회차 정산서의 지급이 늦어진다. 이미 지급이 나간 정산서는 다시 계산하지 않아 회차 취소 환급이 미수금으로만 돌아온다. 대사 풀림의 조정은 사람이 승인해야 끝난다.
- 남는 한계: purchase-svc와 payment-svc의 보낸 시각 칸이 어긋나면(보류 열기 답을 잃음) 같은 요청 ID로 다시 부르므로 멱등에 기댄다. 보류 사유·이동 종류·이의 결과 값이 하나씩 늘어 payment 마이그레이션 0033이 든다.
