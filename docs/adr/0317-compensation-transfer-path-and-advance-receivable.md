# ADR-0317: 배상금 지급 경로 — purchase-svc가 송금을 요청하고, PAID일 때만 COMPENSATION_ADVANCE 미수금을 만든다(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 승인). 갈래 3 BAT-425 계획 담당이 빈칸을 모아 감독에게 올렸고, 감독이 결정 3·5·6을 승인했다. [ADR-0046](0046-cancel-transfer-refund-approvals.md) 결정 5(배상·회수 순서), [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 3(환급 계좌는 바로 넘길 때만), [ADR-0293](0293-fan-reauth-token-bound-to-receiving-operation.md)(재인증 `op`), [ADR-0315](0315-merch-cancel-return-state-machine.md)(환급 계좌 미저장)를 그대로 쓴다.
- **관련**: [docs/features/transfer-refund.md](../features/transfer-refund.md) §6 '배상 지급', [docs/features/settlement.md](../features/settlement.md) §7 '미수금 상계', [docs/features/payment.md](../features/payment.md) §6, [docs/data.md](../data.md) `compensation`·`compensation_transfer`·`partner_receivable`, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/compensations*`, [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto) `CompensationTransferService`, [ADR-0046](0046-cancel-transfer-refund-approvals.md) 결정 5, 계획 [docs/review/plans/BAT-425.md](../review/plans/BAT-425.md)
- **관련 ID**: R-T46, R-T47, J-T28, FR-056, POL-014, POL-019, POL-038, BUILD_ORDER GAT-130

## 맥락

- 회차 취소가 주최 측 귀책(`ORGANIZER`)이나 공연 내용 변경(`CONTENT_CHANGE`)으로 확정되면 분쟁해결기준에 따라 실제 결제 금액의 10%를 배상한다(ADR-0046 결정 5). 결제 취소로 결제액보다 많이 돌려줄 수 없어, PEAKET이 결제자 계좌로 먼저 송금하고 파트너 정산에서 상계·보증·청구로 회수한다.
- 지금 payment-svc에는 배상 송금 gRPC(`CompensationTransferService`)와 메모리 가짜 어댑터만 있고, DB 기록·`Get` 영속·`COMPENSATION_ADVANCE` 미수금 생성이 없다. 주문·환급·배상 대상은 purchase DB에 있고 팬의 계좌 입력도 purchase-svc가 받는다.
- ops-svc가 송금을 부르는 경로를 계획은 제안했지만, ops-svc는 회차 취소 확정과 CS 건만 맡고 주문별 대상·계좌 입력은 모른다. purchase-svc가 이미 그 문맥을 갖고 있다.
- 실제 지급대행·은행 계정·KYC가 없다. 이 묶음은 그 앞뒤의 기록·계약·미수금만 만들고, 운영에서는 `UNAVAILABLE`(503)로 드러낸다.

## 결정

1. **송금을 부르는 곳은 purchase-svc다**: 회차 취소 확정이 purchase DB `compensation` 행을 만들고, 팬이 `POST /v1/compensations/{compensationId}/account`로 계좌를 넣으면 purchase-svc가 payment-svc `RequestCompensationTransfer`를 `compensation_id` 멱등으로 부른다. ops-svc는 송금을 부르지 않는다(회차 취소 확정·CS 건만).
2. **배상 대상 행**: 확정 때 주최 측 귀책·공연 내용 변경이면 대상 주문마다 `compensation` 한 행을 만든다. 금액은 미리보기에서 주문 단위로 한 번 계산해 `dry_run.compensationOrders`에 남긴 값을 쓴다(확정 때 주문·표가 바뀌어도 흔들리지 않게). 목록이 없는 옛 요청은 확정 때 같은 함수로 다시 계산하고, 계산할 수 없으면 배상 행 0·경고 로그다(빠뜨린 채 지급하지 않는다). `FORCE_MAJEURE`는 행 0. `status = ACCOUNT_PENDING`, `account_last4`·`receivable_id` 빈 값, `(event_cancellation_request_id, order_id)` 유일이다.
3. **payment-svc 기록**: `compensation_transfer`에 `compensation_id` 유일로 한 행. 상태 `REQUESTED`·`PAID`·`FAILED`·`UNAVAILABLE`, 실패 까닭은 개인정보 없는 이름표만. 같은 `compensation_id`의 다시 부름은 저장한 상태·`transfer_id`를 그대로 준다. 계좌 원문은 저장하지 않고 `account_last4`만 남긴다.
4. **미수금은 PAID일 때만**: 송금이 `PAID`이면 payment-svc가 `partner_receivable` 한 행(`cause = COMPENSATION_ADVANCE`, `pg = NULL`, `promoter_id`, `event_id`, `amount`, `remaining = amount`, `status = OPEN`, `source_ref = compensation:{id}`)을 만들고 `receivable_id`를 답에 싣는다. `REQUESTED`·`FAILED`·`UNAVAILABLE`에는 0행. 같은 `compensation_id`를 다시 `PAID`로 받아도 `source_ref` 부분 유일로 1행이다.
5. **상계**: 기존 지급 묶음 만들기가 같은 파트너의 열린 미수금을 지급액에서 먼저 빼고 `receivable_movement` 한 줄과 `remaining`·`status`를 같은 트랜잭션에 쓴다. `COMPENSATION_ADVANCE`는 결제사와 무관하게 상계한다. 같은 미수금을 두 정산서가 두 번 상계하지 않는다(행 잠금·로컬 추적).
6. **오류·끝**: `UNAVAILABLE`이면 purchase-svc가 503 `compensation-transfer-unavailable`(Retry-After 5초 [가정])로 답한다. `FAILED`면 422 `compensation-transfer-failed`·`status = FAILED`·CS `COMPENSATION_PENDING` 한 건으로 이 묶음에서 끝낸다(재송금은 다음 묶음·CS 판단). `REQUESTED`·`PAID`면 202 `Compensation`이다.
7. **운영 안전**: payment-svc 배상 송금은 지금처럼 가짜 어댑터이고 `PEAKET_COMPENSATION_TRANSFER_MODE=fake`일 때만 `REQUESTED`를 돌려준다. 운영(prod·staging)에서 fake 모드면 시작 실패다. 계좌 원문은 요청 안에서만 쓰고 로그·사건·Outbox·지표에 싣지 않는다(POL-014).

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. purchase-svc가 송금을 부르고 payment-svc가 미수금을 만든다(이 결정) | 주문·배상 대상·계좌 입력 문맥이 한 곳에 있고, 돈을 내보내는 실행은 payment-svc에 모인다 | purchase-svc가 payment-svc gRPC 클라이언트를 더 조립한다 | 고른다 |
| B. ops-svc가 송금을 부른다 | 운영 콘솔에서 한 곳으로 보인다 | ops-svc가 주문별 배상 대상·계좌를 알려면 purchase DB를 더 읽어야 하고, 팬 요청 경로와 멀다 | 쓰지 않는다 |
| C. 송금 요청(`REQUESTED`) 때 미수금을 만든다 | 상계가 빨리 보인다 | 송금이 실패하면 파트너에게 청구할 돈이 없는데 미수금이 남는다 | 쓰지 않는다 |
| D. 계좌번호 원문을 compensation에 저장한다 | 재송금이 쉽다 | 개인정보 암호화 의무·유출 위험이 생긴다(POL-014) | 쓰지 않는다 |

## 결과

- 배상금은 회차 취소 확정 → 대상 행 → 팬 계좌 입력 → 송금 요청 → `PAID` 미수금 → 다음 정산 상계까지 한 줄로 이어진다. 계좌는 끝 4자리만 남는다.
- 대가: purchase `compensation` 표·`order_cancellation.refund_attempt`(0030), payment `compensation_transfer` 표와 `partner_receivable`의 `pg NULL`·`event_id`·`source_ref`(0024), core `merch_refund.replaces_refund_id`(0032)가 는다. purchase-svc에 gRPC 클라이언트·재인증 게이트·CS 건 코드가 는다.
- 남는 한계: 실제 지급대행·은행 이체·KYC, 알림 발송·계좌 입력 요청 재발송, 보증·청구로 넘기는 수동 전이, 화면은 다음 묶음·GAT-250·GAT-280·BAT-421이다. `FAILED` 뒤 재송금은 CS가 판단한다.

## 되돌릴 조건

- 실제 지급대행이 붙어 `PAID`가 흔해지면 `compensation_transfer`와 `partner_receivable` 생성 시점을 한 트랜잭션으로 묶는 범위를 다시 본다(지금은 송금 답을 받은 뒤 두 쓰기다).
- `COMPENSATION_ADVANCE` 상계가 특정 결제사 정산서에서 자주 막히면 `listOpenReceivables`의 결제사 무관 조건을 다시 본다.
- 배상 실패가 CS에서 대부분 재송금으로 풀리면 `FAILED`를 끝으로 두지 않고 재시도 상한을 정해 자동 재송금을 더한다.
