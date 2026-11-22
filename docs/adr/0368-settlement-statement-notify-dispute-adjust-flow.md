# ADR-0368: 정산서 통지·이의·확정·수기 조정은 조건부 상태 전이와 한 트랜잭션 Outbox로 하고, 조정 적용은 ops 승인 기록과 대조한다(2026-11-23)

- **상태**: 채택(2026-11-23, 추천 적용, BUILD_ORDER F-07-5 계획). 2026-11-15 A1 감사의 A1-M6(수기 조정·이의 기각 경로 없음)·A1-M7(정산 사건 없음)과 BAT-625 리뷰 RV-04(모두 보류면 `HELD`를 저장하지 않음)를 닫는다.
- **관련**: [ADR-0047](0047-settlement-payout-via-pg-agency.md), [ADR-0062](0062-open-items-delegated-decisions.md), [ADR-0123](0123-sale-review-suspended-takedown-resume-or-cancel.md), [ADR-0197](0197-fraud-cancellation-call-settlement-screen-contract-additions.md), [ADR-0345](0345-payout-batch-approval-lookup-via-ops-internal-http.md), POL-038 ⑦, POL-039, docs/features/settlement.md §4.2·§4.3·§4.4·§13, docs/planning/03-policies-glossary.md §2.12, docs/data.md `settlement_statement`·`statement_dispute`·`statement_adjustment`, docs/api/guidelines.md §8.1
- **관련 ID**: FR-062, J-T1, J-T2, J-T10, J-T12, J-T35, J-T36

## 맥락

- 첫 구현(2026-11-15, R-588)은 정산서를 처음부터 `NOTIFIED`로 넣었고 알림 사건(`trade.settlements`)을 내는 코드가 없었다. 계약(asyncapi `SettlementEvent`)만 있고 생산자가 없었다(A1-M7).
- KYC가 끝나지 않은 파트너의 정산서는 계산 때 바로 `HELD`, 지급액 0인 정산서는 바로 `CARRIED_OVER`로 들어가 통지와 이의 기간을 건너뛰었다. 상태도(docs/planning/03 §2.12)에는 `Calculated → Held`·`Calculated → CarriedOver` 전이가 없다.
- 정산서 상태는 행을 덮어써 저장했다. 이의와 자동 확정이 같은 순간에 오면 이의 행이 남은 채 `CONFIRMED`가 되어 지급 묶음에 들어갈 수 있었다.
- 이의 기각·수기 조정 경로와 `statement_adjustment` 표가 없어, 이의가 오면 정산서가 `DISPUTED`에 머물렀다(A1-M6). 내부 결과 경로는 조정 없이 `ADJUSTED`를 적을 수 있었다.
- 이의 기간을 주말만 빼고 UTC 날짜로 셌다. 정본은 사람이 일하는 기한을 공휴일 달력으로 센다(settlement §5.1).
- 수기 조정은 돈을 바꾸는 2인 승인이다. ADR-0345와 같은 이유로, payment-svc가 승인 ID만 믿고 적용하면 내부 토큰을 가진 신원이 승인 없이 지급액을 바꿀 수 있다.

## 결정

1. **계산과 통지는 한 트랜잭션이다.** 정산서 행을 `CALCULATED`로 넣고 같은 트랜잭션에서 `NOTIFIED`로 바꾸며, 감사 한 줄과 `trade.settlements` `STATEMENT_NOTIFIED`(키 = 파트너 ID)를 Outbox 마지막 문장으로 쓴다(플랫폼 `writeOutbox`, payment-svc Outbox 릴레이가 그대로 보낸다). 계산 때는 보류하지 않고, 지급액이 0 이하여도 통지한다. 보류는 지급 묶음 때(T7), `CARRIED_OVER`는 확정 때(T6) 한다.
2. **모든 상태 전이는 조건부 갱신이다.** 저장소에 '출발 상태 목록·도착 상태·바꿀 칸·감사·사건'을 받는 전이 한 가지를 두고, `WHERE status IN (출발 상태)`가 맞을 때만 상태·감사·Outbox를 한 트랜잭션에 쓴다. 맞지 않으면 아무것도 쓰지 않고 409 `settlement-state-conflict`다. 이의·기각·조정 적용·자동 확정·재확정·지급 묶음 때의 보류가 모두 이 전이를 쓴다.
3. **사건 종류**: 정산서 사건 `STATEMENT_NOTIFIED`(통지·다시 알림, 판본·옛 판 ID 포함)·`STATEMENT_DISPUTED`·`STATEMENT_CONFIRMED`·`STATEMENT_CARRIED_OVER`와, 확정 때 만드는 `NEGATIVE_STATEMENT` 미수금의 `RECEIVABLE_OPENED`를 이 결정이 쓴다. 지급 사건(`PAYOUT_*`)과 `RECEIVABLE_CLOSED`는 지급 실행 단계(LCH-110)가 쓴다. `trade.settlements`를 받아 파트너 웹훅 `statement.notified`로 보내는 core-svc 소비자는 GAT-270의 운영 전 몫이다.
4. **이의 기한은 KST 공휴일 달력이다.** 통지(또는 다시 알림) 시각에서 주말·공휴일을 뺀 2영업일(다시 알림은 1영업일) 뒤 같은 시각이 기한이고, 그 시각부터 닫힌다. 공휴일 파일은 purchase-svc와 같은 `PEAKET_HOLIDAY_CALENDAR_FILE`이고 없으면 주말만 뺀다 [가정]. 지급일 계산(은행 영업일)은 이 결정이 바꾸지 않는다.
5. **이의는 `NOTIFIED`이고 기한 전일 때만 받는다.** 받은 뒤 ops-svc CS 처리함 `POST /internal/v1/cs-cases`로 `STATEMENT_DISPUTE` 건을 연다. 이의를 먼저 커밋하고, 건을 열지 못하면 `statement_dispute.case_requested_at`을 비운 채 두어 정산 일꾼이 30분 [가정]마다 다시 보낸다(purchase-svc 환급 실패 건과 같은 모양). ops-svc는 이 종류를 받기 시작한다.
6. **기각은 `cs_lead`, 인정은 수기 조정 적용으로만 한다.** ops-svc `POST /v1/ops/settlements/{statementId}/dispute-dismissal`이 payment-svc 내부 기각 경로를 불러 열린 이의를 `DISMISSED`·사유·처리자로 닫고 정산서를 `NOTIFIED`(1영업일)로 돌린다. 옛 내부 결과 경로(`…/disputes/{disputeId}/resolution`)는 없앤다.
7. **수기 조정은 payment가 조정 행을, ops가 승인을 갖는다.** `cs_lead`가 ops-svc `POST /v1/ops/settlements/{statementId}/adjustments`를 부르면 ops가 승인 업무 ID를 먼저 정해 payment에 조정 행을 `PENDING`으로 등록하고(검사는 payment가 한다), 그다음 공통 승인 표 `approval_request`(종류 `SETTLEMENT_ADJUSTMENT`)를 만든다. ops-svc 표는 바꾸지 않는다(이의 ID·근거 메모는 payment 조정 행에 있다). 요청자가 아닌 commander가 `act=APPROVAL` 재인증 뒤 승인하면 ops가 payment 적용 경로를 부른다.
8. **적용은 ops 승인 기록과 대조한다.** payment-svc는 ops-svc 내부 `GET /internal/v1/approval-requests/{approvalId}`(새 경로, 사실만, `no-store`)로 종류·대상 정산서·금액·사유 코드·상태(`APPROVED`·`EXECUTING`)·정족수 2·요청자≠승인자·승인 시각을 조정 행과 대조하고, 어긋나면 409, ops가 답하지 않으면 503이며 아무것도 바꾸지 않는다. 맞으면 한 트랜잭션에 조정 행 `APPLIED`, `settlement_statement.adjustment_amount`·`payout_amount`, 이의 `ADJUSTED`(인정이면), `NOTIFIED`(1영업일), 감사, `STATEMENT_NOTIFIED`를 쓴다. 같은 승인 ID의 재적용은 처음 결과를 준다.
9. **조정할 수 있는 상태는 `NOTIFIED`·`DISPUTED`·`CONFIRMED`뿐이다.** `HELD`는 보류가 풀린 뒤 조정한다 [가정]. 이의 없는 조정으로 `CONFIRMED`가 `NOTIFIED`로 돌아가는 전이 T18을 상태도에 더한다. 파트너가 바뀐 금액을 보고 이의를 낼 수 있게 하려는 것이다.
10. **확정 때 0 이하를 끝낸다.** 자동 확정(T5)과 재확정(T8)이 같은 트랜잭션에서 지급액 0 이하면 `CARRIED_OVER`로 끝내고, 0 아래면 그 결제사의 미수금 `NEGATIVE_STATEMENT`(근거 `negative-statement:{정산서 ID}`, 부분 유일)를 만든다. 지급 묶음은 지급액 0 이하인 정산서를 담지 않는다.
11. **모두 보류된 지급 묶음 요청도 보류를 저장한다.** 판매 중지·KYC·계좌 변경·계좌 불일치로 확정 정산서가 하나도 남지 않으면, 그 정산서들을 `HELD`·사유로 조건부 저장한 뒤 409를 돌려준다(BAT-625 RV-04).
12. **자동 확정과 CS 건 다시 보내기는 30분 [가정]마다 돈다.** 회차 계산은 지금처럼 평일 06시 한 번이고, 상품 정산서 계산은 주의 첫 영업일 06시(공휴일 달력)에 지난주 월~일을 대상으로 같은 일꾼이 한다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| 정산서를 `NOTIFIED`로 바로 넣고 사건만 따로 보낸다 | 기각. 사건과 행이 다른 트랜잭션이면 하나만 남는 경우가 생긴다. Outbox를 같은 트랜잭션에 쓰는 원칙(ADR-0047·docs/streaming.md)과 다르다 |
| 이의를 받을 때 ops CS 건을 먼저 열고 이의를 쓴다 | 기각. 이의가 기한·경합으로 거절되면 이의 없는 CS 건이 남는다. 이의를 먼저 쓰고 건은 다시 보내기로 맞춘다 |
| CS 건을 `support.cases-requested` Kafka 사건으로 연다 | 이번에는 기각. ops-svc 소비자 조립이 아직 없다(GAT-110 후속). purchase-svc와 같은 내부 HTTP를 쓰고, 소비자가 생기면 Outbox 사건으로 바꾼다 |
| 수기 조정 내용을 ops-svc에 새 표로 둔다 | 기각. 이 갈래에 ops-svc 마이그레이션 몫이 없고, 조정의 검사(이의 코드·상태)는 정산서를 가진 payment-svc가 해야 한다. 승인은 공통 표, 내용은 payment 조정 행으로 나눈다 |
| 조정 적용 때 승인 ID만 믿는다 | 기각. ADR-0345가 닫은 것과 같은 위조 길이 열린다 |
| 이의 없는 조정 뒤 `CONFIRMED`를 그대로 둔다 | 기각. 파트너에게 알린 금액이 말없이 바뀐다. 다시 알리고 1영업일 이의를 준다(T18) |
| 다시 계산(판본 +1·`SUPERSEDED`)도 이번에 넣는다 | 이번에는 하지 않는다. 다시 계산의 원천은 회차 취소·연기 일괄 환불이고, 그 흐름(F-07-8)과 함께 J-T23으로 시험해야 의미가 있다 |

## 결과와 트레이드오프

- **좋은 점**: 통지·이의·확정·조정이 상태도대로만 움직이고, 겹친 전이는 하나만 남는다. 파트너 통지 사건이 생겨 받는 쪽이 붙으면 바로 쓸 수 있다. 조정은 2인 승인 기록과 대조해야만 적용된다.
- **남는 한계**: `trade.settlements` 소비자(파트너 웹훅·이메일)가 아직 없어 파트너는 SCR-027 목록으로만 통지를 본다(GAT-270 운영 전). Kafka 토픽은 로컬·CI 객체 목록에만 더하고 운영 토픽 준비는 인프라 몫이다. 다시 계산, 계산 뒤 환급의 미수금(J-T11·ADR-0197 결정 2의 계산 뒤 몫), 환급의 PEAKET 부담분(면제분·시스템 잘못) 제외는 F-07-8에 남는다. 조정 화면(SCR-046 카드·CS 처리함 건 상세)은 API만 있고 화면은 GAT-290·GAT-110 몫이다.
- **배포**: payment 0027(조정 합계 칸, 이의·조정 행 칸, 부분 유일 인덱스 둘). 옛 `NOTIFIED`·`HELD(KYC)`·`CARRIED_OVER` 행은 그대로 두고 새 규칙은 새 계산부터 쓴다.

## 되돌릴 조건

- ops-svc `support.cases-requested` 소비자가 조립되면 결정 5의 내부 HTTP를 Outbox 사건으로 바꾸고 이 ADR을 고친다.
- `payout_approval`과 공통 승인 표를 합치면(GAT-290) 결정 8의 승인 기록 경로를 그 모양에 맞춘다.
- 은행 영업일 달력의 출처가 정해지면(settlement §5.1, wbs 5.3.1) 결정 4의 공휴일 파일과 지급일 달력을 함께 본다.

## 확인

- J-T35 ①~⑨, J-T36 ①~⑦, J-T1·J-T2·J-T10·J-T12가 이 결정을 본다. `trace-check --ids "J-T1,J-T2,J-T10,J-T12,J-T35,J-T36"`와 `ledger --batch F-07-5 --require`로 확인한다.
