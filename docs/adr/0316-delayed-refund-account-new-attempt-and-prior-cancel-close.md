# ADR-0316: 지연 환급 계좌를 다시 받을 때 같은 취소 ID의 새 시도 번호와 앞 진행 중 행 닫기(2026-11-20)

- **상태**: 채택(2026-11-20, 감독 승인). 갈래 3 BAT-425 계획 담당이 빈칸을 모아 감독에게 올렸고, 감독이 결정 2·4·5·6을 승인했다. [ADR-0050](0050-crypto-corrections-and-key-management.md) 결정 3(환급 계좌는 바로 넘길 때만), [ADR-0293](0293-fan-reauth-token-bound-to-receiving-operation.md)(재인증 받는 쪽 작업 `op`), [ADR-0315](0315-merch-cancel-return-state-machine.md)(굿즈 취소·반품 상태 기계)의 규칙을 그대로 쓰고, 같은 취소의 두 번째 시도를 여는 부분만 더한다.
- **관련**: [docs/features/payment.md](../features/payment.md) §4.1 '취소 건 기록과 기대 잔액'·§6 '가상계좌 환불 계좌 전달의 첫 구현', [docs/features/transfer-refund.md](../features/transfer-refund.md) §3.1 '팬 취소의 재인증 확인'·§5 '일괄 환불', [docs/features/settlement.md](../features/settlement.md) §7, [docs/data.md](../data.md) `payment_cancel`, [docs/api/openapi.yaml](../api/openapi.yaml) `/v1/cancellations/{cancellationId}/account`·`/v1/shop/orders/{orderId}/cancellations/{cancellationId}/account`, [docs/api/proto/peaket/payment/v1/payment.proto](../api/proto/peaket/payment/v1/payment.proto) `CancelPaymentRequest.refund_attempt`, 계획 [docs/review/plans/BAT-425.md](../review/plans/BAT-425.md)
- **관련 ID**: P-T76, R-T42, R-T43, P-T63 ③, P-T74 ③, FR-047, FR-015, POL-014, POL-032, BUILD_ORDER GAT-120·GAT-130

## 맥락

- 가상계좌로 결제한 팬이 입장 시작 뒤에 취소하거나, 결제사 취소 장애로 환급을 미루면 그때는 계좌를 받지 않는다(ADR-0050 결정 3). 환급할 수 있게 되면 `POST /v1/cancellations/{cancellationId}/account`로 계좌를 다시 받는다.
- 그런데 지금 payment-svc는 같은 취소 ID에 이미 `payment_cancel` 행이 있으면 계좌가 있어도 다시 보내지 않고 조회로만 끝을 본다(같은 멱등키 = 같은 본문). 계좌가 없어서 `REFUND_ACCOUNT_REQUIRED`로 끝난 뒤 팬이 계좌를 넣어도 **같은 멱등키로 새 계좌를 보낼 길이 없다**. 굿즈도 `merch_refund`가 `REJECTED(REFUND_ACCOUNT_REQUIRED)`로 끝난 뒤 새 취소 ID를 만들 길이 없다.
- BAT-420-rest RN-03이 남긴 이중 환불 조건: 계좌를 실은 취소가 결과 모름(`REQUESTED`)으로 진행 중이면 결제사가 늦게 반영할 수 있다. 그 상태에서 다른 계좌·새 멱등키로 새 취소를 보내면 실제로는 두 번 환급될 수 있다. 앞 행을 조회로 먼저 닫아야 한다.
- 지금 `beginConfirmedCancel`은 같은 결제의 다른 진행 중 행이 만든 지 10분 [가정] 안이면 `BUSY`로 막는다. 10분이 지나면 새 취소 ID로 결제사를 부른다. 이 규칙은 새 계좌 시도에는 맞지 않는다(10분을 기다리게 되어 팬이 기다린다).

## 결정

1. **시도 번호와 멱등키**: 같은 취소 ID의 환급 시도는 `refund_attempt`(0~3 [가정])로 센다. 0은 첫 시도이고 멱등키는 `cancel-{cancellationId}`다. 1~3은 계좌를 다시 받은 시도이고 멱등키는 `cancel-{cancellationId}-a{n}`이다. 같은 시도의 재시도는 같은 키를 쓴다. `payment_cancel.attempt`와 purchase `order_cancellation.refund_attempt`에 같은 번호를 적는다. 4 이상은 `INVALID_ARGUMENT`이고 결제사·저장소에 가지 않는다. 다른 호출자(회차 취소·부정 예매·탈퇴)는 시도 0 그대로다.
2. **새 시도 전 앞 행 닫기(B1~B5)**: 가상계좌 결제에 계좌를 실은 **새 시도**(그 키의 행이 없음)는 결제사 취소를 부르기 전에 그 결제의 진행 중(`REQUESTED`·`CANCEL_PENDING`) 행을 새 키를 빼고 읽는다.
   - `CANCEL_PENDING`이 있으면 새 전송 0·결과 모름이다(결제사가 비동기로 받아들였다).
   - `REQUESTED`가 하나면 결제사에 한 번 조회한다. 조회 잔액 = 그 행의 기대 잔액 − 금액이고 다른 진행 중 행이 없으면 반영으로 보고 그 행을 `CANCELED`로 끝내며 원장에 한 번 반영한다. **새 전송은 0**이고 새 시도 행은 `CANCELED` 표시로만 남긴다(같은 시도의 재시도가 다시 보내지 않게). 조회가 반영이 아니면 그 행을 `FAILED(fail_reason = SUPERSEDED)`로 조건부로 닫고 새 시도를 보낸다(0행이면 새 전송 0·결과 모름).
   - 진행 중 행이 둘 이상이거나 조회가 실패하면 새 전송 0·결과 모름이다(잔액으로 어느 행의 반영인지 가를 수 없다). 행은 그대로 두고 CS가 결제사 기록으로 정리한다.
   - 새 시도에는 10분 [가정] 창을 적용하지 않는다. 앞 행이 `CANCEL_PENDING`이거나 가를 수 없을 때만 멈춘다.
3. **옛 시도 번호의 다시 부름**: `FAILED(SUPERSEDED)`로 닫은 옛 시도를 다시 부르면 결제사 0·`REJECTED`다. 옛 시도가 `CANCELED`면 같은 취소 ID의 새 시도는 행을 만들지 않고 `CANCELLED`다. 계좌 거절로 끝난 `FAILED(REFUND_ACCOUNT_INVALID)`은 지금처럼 같은 시도의 다시 부름에 `REFUND_ACCOUNT_REQUIRED`다(같은 시도 = 같은 답). 새 계좌는 새 시도 번호로 보낸다.
4. **예매 취소 계좌 다시 받기(HTTP)**: `POST /v1/cancellations/{cancellationId}/account`는 결제자 본인·`REFUND_PENDING`·`refund_account_required_at` 있음·`refund_attempt < 3` [가정]일 때만 받는다. 재인증 `op = REFUND_ACCOUNT`·`act = FAN_HIGH_RISK`이고 계좌는 저장하지 않는다. `order_cancellation` 행 잠금 안에서 시도를 1 올리고 커밋한 뒤 `CancelPayment`를 같은 취소 ID·같은 금액·같은 사유·계좌·새 시도 번호로 부른다. `CANCELLED`면 202 `REFUNDED`, `CANCEL_PENDING`·`UNKNOWN`이면 202 `REFUND_PENDING`·`next_refund_at` 1분 [가정], `REFUND_ACCOUNT_REQUIRED`면 422·계좌 대기 유지, 그 밖 `REJECTED`면 422·CS '환급 실패'다.
5. **굿즈 취소 계좌 다시 받기(HTTP)**: `POST /v1/shop/orders/{orderId}/cancellations/{cancellationId}/account`를 core-svc shop에 새로 둔다. `merch_refund`가 `REJECTED`·`fail_reason = REFUND_ACCOUNT_REQUIRED`·`account_required_at` 있음일 때만 받고, 재인증 `op = SHOP_CANCEL_REFUND_ACCOUNT`·`act = FAN_HIGH_RISK`다. 새 `merch_refund` 행(새 UUIDv7 취소 ID, `replaces_refund_id` = 옛 ID, `kind`·`amount` 그대로)과 새 `merch_refund_item` 자리를 한 트랜잭션에 만든 뒤 새 취소 ID로 `CancelPayment`를 부른다. 옛 행은 `REJECTED` 그대로 둔다. 옛 행 하나는 새 행 하나로만 대신하고(부분 유일 인덱스), 경로의 취소 ID가 옛 행이면 `replaces_refund_id` 사슬의 끝 행을 다시 본다. 시도 번호는 사슬 깊이 + 1(3회 [가정] 상한)이고 이 번호를 `CancelPayment.refund_attempt`에 실어 새 취소 ID의 멱등키를 `cancel-{새 ID}-a{n}`으로 가르며, 자동 재시도도 같은 번호를 쓴다. 같은 `Idempotency-Key`는 새 행을 두 번 만들지 않고 처음 답을 준다. 별도 공유 경로로 하면 core-svc 안의 굿즈 환급 행을 purchase-svc가 내부 조회해야 해 경계가 흐려지므로, 소유가 분명한 이 경로를 골랐다.
6. **은행 코드 허용 목록**: 공용 `refundAccountShape`와 payment-svc `refundAccountOf`는 토스 은행 코드 표의 두 자리 26개만 받는다(02·03·06·07·11·12·20·23·27·31·32·34·35·37·39·45·48·50·54·64·71·81·88·89·90·92). 목록 밖 두 자리(예 `99`)는 purchase·core-svc에서 400 `invalid-body`이고, payment-svc에서는 계좌가 없는 것과 같게 `REFUND_ACCOUNT_REQUIRED`다(깊은 방어).
7. **지표**: `payment_cancel_supersede_total{result}`(`applied`·`not_applied`·`undecidable`), `purchase_refund_account_total{result}`, `shop_refund_account_total{result}`. 계좌·카드·결제 키는 어디에도 싣지 않는다.

## 검토한 대안 (트레이드오프)

| 대안 | 이런 점이 낫다 | 이런 점이 걸린다 | 판단 |
| --- | --- | --- | --- |
| A. 같은 취소 ID에 새 시도 번호·새 멱등키를 두고, 새 시도 전 앞 행을 조회로 닫는다(이 결정) | 같은 취소의 이력이 한 줄기에 남고, 결제사 멱등키가 시도마다 달라 실제 새 전송이 가능하다 | 시도 번호·행 닫기·표시 행이 늘고, 호출자가 시도 상한을 지켜야 한다 | 고른다 |
| B. 새 계좌를 받을 때마다 새 취소 ID를 만든다 | payment-svc를 거의 안 고친다 | 같은 취소의 이력이 여러 ID로 흩어지고, 앞 진행 중 행과의 이중 환급 조회를 여전히 해야 한다 | 쓰지 않는다 |
| C. 앞 진행 중 행이 있으면 늘 `BUSY`로 10분을 기다린다 | 구현이 단순하다 | 팬이 10분을 기다리고, 10분 뒤에도 결과를 모르면 같은 문제가 다시 생긴다 | 쓰지 않는다 |
| D. `CANCEL_PENDING`도 닫고 새 전송 | 기다리지 않는다 | 결제사가 이미 받아들인 취소와 새 취소가 겹쳐 이중 환급이 난다 | 쓰지 않는다 |

## 결과

- 가상계좌 결제의 지연 환급에서 팬이 계좌를 다시 넣으면, 앞 시도의 결과를 먼저 확인한 뒤에만 새 전송이 나간다. 앞 시도가 이미 반영됐으면 돈은 한 번만 나가고 팬은 `REFUNDED`를 본다.
- 대가: `payment_cancel.attempt`(payment 0024), purchase `order_cancellation.refund_attempt`(purchase 0030), core `merch_refund.replaces_refund_id`(core 0032)가 는다. payment-svc·purchase-svc·core-svc에 새 시도·닫기·표시 행 코드가 는다.
- 남는 한계: 오래된 `payment_cancel` 행 정리·일일 대사는 HOT-153·CS가 본다. 실제 지급대행·계좌 입력 알림 재발송은 GAT-250·GAT-280이다. 화면은 BAT-421이다.

## 되돌릴 조건

- 시도 상한 3회 [가정]를 대부분 소진하는 건이 생기면 상한을 올리거나 계좌 입력을 다시 받는 흐름을 GAT-280과 함께 본다.
- `SUPERSEDED`로 닫힌 행이 CS에서 자주 문제가 되면, 앞 행을 닫는 대신 새 취소 ID를 만들고 옛 행을 CS가 정리하는 길을 다시 본다.
- 결제사가 같은 금액의 두 취소를 모두 받아들이는 사례가 실제 샌드박스에서 확인되면, 조회 대조(잔액)만으로는 부족하므로 결제사 취소 목록 조회를 더한다.
