# ADR-0345: 지급 묶음 승인 ID는 ops-svc 내부 HTTP로 대조한다(2026-11-22)

- **상태**: 채택(2026-11-22, 추천 적용, BUILD_ORDER BAT-625 계획). W12-mesh 리뷰 RV-01(보안 높음)을 닫는다.
- **관련**: [ADR-0285](0285-mesh-port-allow-source-generated-policies.md) 결정 9(REST 포트의 내부 HTTP 부르는 쪽), [ADR-0047](0047-settlement-payout-via-pg-agency.md), [ADR-0123](0123-sale-suspension-and-resumption.md), [ADR-0320](0320-promoter-contract-terms-and-commission-rate-freeze.md), POL-038, docs/features/settlement.md §5.1·§6·§13, docs/security/asvs/settlement.md V2·V8·V16
- **관련 ID**: FR-062, J-T31, R-T23 ②

## 맥락

- payment-svc `settlements.ts`의 `approveBatch`는 받은 `approvalId`를 문자열로만 받아 `payout_batch.approval_id`에 적고 상태를 `APPROVED`로 바꿨다. ops-svc의 지급 승인 기록(`payout_approval`)을 읽지 않았으므로, payment-svc REST 8080에 닿는 내부 신원(메시상 ops-svc·purchase-svc)과 공유 내부 토큰만 있으면 ops-svc의 2인 승인 없이 지급 묶음을 승인하고 이어서 실행할 수 있었다(W12-mesh RV-01).
- 지급한 돈은 결제사가 되돌려 주지 않는다. 그래서 승인 근거를 payment-svc가 스스로 확인해야 한다. ops-svc의 2인 승인(요청자≠승인자)은 이미 `payout_approval`에 남지만, 그 기록을 다른 서비스에 보여 주는 내부 경로가 없었다.
- payment-svc는 이미 core-svc·identity-svc 내부 HTTP를 부른다. ops-svc는 payment-svc를 부르는 쪽이다. payment-svc가 ops-svc를 부르면 두 서비스가 서로를 부르는 모양이 되지만, 지급 승인 한 건을 확인하는 짧은 읽기라 요청 처리 안에서 안전하게 끝난다.
- `payout_approval`을 공통 승인 표 `approval_request`·`approval_vote`로 합치는 일은 GAT-290에 남아 있다. 이 ADR은 지금 표를 그대로 읽는다.

## 결정

1. **payment-svc가 ops-svc 내부 HTTP `GET /internal/v1/payout-approvals/{approvalId}`를 부른다.** 응답은 대조에 필요한 사실만 싣는다: `approvalId`, `kind=PAYOUT_BATCH`, `targetRef`·`batchId`, `pg`·`pgStore`·`payoutDate`, `currency=KRW`, `amount`, `statementCount`, `status`, `requiredApprovals=2`, `requestedBy`, `approvals`(승인자 ID 목록), `approvedAt`. 사유 글·요청자 역할·계좌·내부 토큰은 싣지 않고 `cache-control: no-store`다. 없으면 404다.
2. **`approveBatch`의 대조 규칙**:
   - `kind`가 `PAYOUT_BATCH`이고 `targetRef`·`batchId`가 그 배치여야 한다.
   - `pg`·`pgStore`·`payoutDate`·`statementCount`가 배치와 같아야 한다.
   - `currency`가 `KRW`이고 `amount`가 배치 `totalAmount`와 같아야 한다.
   - 상태가 `EXECUTING` 또는 `APPROVED`여야 한다. `PENDING_APPROVAL`·`REJECTED`·`FAILED`·`DONE`은 4xx다.
   - `requiredApprovals=2`이고 `requestedBy`와 다른 승인자가 하나 이상 있어 두 사람이어야 한다. `approvedAt`이 있어야 한다.
   - 어긋나면 4xx(409 중심)이고 `payout_batch` 상태를 바꾸지 않는다.
3. **멱등·재사용**:
   - 같은 승인 ID로 같은 배치를 다시 승인하면 ops-svc를 다시 부르지 않고 처음 결과(`APPROVED`·`SUBMITTED`·`COMPLETED`)를 그대로 돌려준다.
   - 같은 승인 ID를 다른 배치에 쓰면 ops 기록의 `batchId`가 달라 409다. payment DB에도 `payout_batch.approval_id` 부분 유일 인덱스(payment 0025)를 두어 두 겹으로 막는다.
   - 이미 다른 승인 ID로 처리된 배치는 409다. `executeBatch`는 `approval_id`가 없는 `APPROVED` 묶음을 실행하지 않는다.
4. **실패는 닫는다.** ops-svc가 5xx·시간 초과·연결 실패·응답 모양 위반이면 503 `dependency-unavailable`이고 `payout_batch`·`payout`·정산서 상태를 바꾸지 않는다. local·ci에서 `PEAKET_OPS_HTTP_URL`이 없을 때도 같은 503이다.
5. **감사와 로그.** 성공은 `payout_batch_audit`(payment 0025)에 배치·승인 ID·요청자·승인자·금액·통화·시각을 배치 상태 저장과 같은 트랜잭션(CAS)에 쓴다. 거절은 상태를 바꾸지 않고 같은 표에 사유와 확인한 사실(있으면)을 따로 쓴다. 서비스 로그에는 `payout_batch_approved`·`payout_batch_approval_rejected`를 구조화해 남기고 계좌번호·내부 토큰은 싣지 않는다.
6. **부르는 쪽 목록에 더한다.** ADR-0285 결정 9의 REST 표에 `payment-svc → ops-svc`(지급 승인 기록 대조) 줄을 보충하고, `deploy/platform/mesh/port-allow.yaml`의 ops-svc REST `callers`에 `payment-svc`를 더한 뒤 생성 파일을 `node tools/ci/mesh-policies.mjs --write`로 다시 만든다. docs/architecture.md §3.2 REST 행과 docs/api/guidelines.md §8.1 내부 HTTP 실패 표에도 적는다.
7. **판매 중지 정산 보류는 같은 묶음에서 닫는다.** core-svc `GET /internal/v1/events/sale-suspensions?eventIds=…`(한 번에 100개)로 회차 묶음의 판매 중지 여부를 읽고, 지급 묶음을 만들 때 중지된 회차의 정산서를 `HELD`·`SALE_SUSPENDED`로 빼며, 실행 직전에도 다시 확인한다. 재확정은 증빙 플래그만 믿지 않고 core에 판매 재개를 다시 확인한다. core가 답하지 않으면 503이고 묶음·정산서 상태를 바꾸지 않는다.

## 검토한 대안

| 대안 | 판단 |
| --- | --- |
| payment-svc가 ops DB를 직접 읽는다 | 기각. 서비스마다 DB 경계를 나눈 규칙(ADR-0007)과 역할 분리를 깬다 |
| ops-svc가 승인 ID를 서명한 증표(토큰)를 payment-svc에 넘기고 payment-svc는 서명만 확인한다 | 이번에는 기각. 서명 키·교체·폐기 표면이 늘고, ops 기록의 대상·금액·상태를 직접 대조하지 못한다. ops 내부 HTTP 한 번이 더 단순하다 |
| 부르는 쪽별 내부 토큰을 나눈다 | 이번에는 기각. 승인 ID 하나의 대상·금액까지는 증명하지 못한다. 승인 기록 대조를 먼저 넣고, 메시 L7 경로 정책(ADR-0285 대안 2)은 후속으로 둔다 |
| payment-svc가 `approvalId`를 받지 않고 ops-svc만 실행하도록 `executeBatch`를 ops 전용 토큰으로 좁힌다 | 기각. 승인 단계의 위조를 막지 못한다. 실행 단계는 승인 상태와 승인 ID를 이미 확인한다 |
| `payout_approval`을 `approval_request`·`approval_vote`로 지금 합친다 | 기각. 표 이관·기존 행·화면·시험이 함께 움직인다. GAT-290으로 넘긴다 |

## 결과와 트레이드오프

- **좋은 점**: 공유 토큰만 가진 내부 신원이 ops 승인 없이 지급 묶음을 승인하는 길이 닫힌다. 승인 근거(대상·금액·통화·건수·2인)가 payment-svc에서 한 번 더 확인되고, 감사 표에 남는다.
- **남는 한계**: payment-svc와 ops-svc가 서로를 부르는 모양이 된다(ops→payment 승인 요청, payment→ops 기록 확인). 두 호출 모두 짧은 읽기/쓰기이고 타임아웃이 있지만, 한쪽이 멈추면 지급 승인·실행이 함께 503으로 닫힌다. 이는 돈 경로의 의도한 닫힘이다. 메시 L7 경로 정책은 여전히 포트 단위라, payment-svc REST에 닿는 다른 내부 신원이 승인 기록 대조를 통과해야만 승인할 수 있다. `payout_approval`과 공통 승인 표의 이중 모양은 GAT-290에 남는다.
- **배포**: `PEAKET_OPS_HTTP_URL`이 없으면 승인은 503이다. 운영 환경 값에 이 주소를 넣어야 지급 승인이 열린다.

## 되돌릴 조건

- ops-svc와 payment-svc 사이 호출이 늘어 지연·가용성 문제가 되면, 승인 기록 대조를 gRPC로 옮기거나 ops-svc가 승인 결과를 밀어 주는 새 ADR을 본다.
- `payout_approval`을 공통 승인 표로 합치면(GAT-290) 이 내부 경로의 응답 모양을 `approval_request`·`approval_vote` 기준으로 바꾸고 이 ADR을 고친다.
- 메시 L7 경로 정책(ADR-0285 대안 2)을 넣으면 이 내부 경로를 경로 허용 목록에 함께 적는다.

## 확인

- J-T31 ①~⑦(단위·HTTP·통합)과 R-T23 ②(단위·통합)가 이 결정을 본다. `trace-check --ids "J-T31,R-T23 ②"`와 `ledger --batch BAT-625 --require`로 확인한다.
- `node tools/ci/mesh-policies.mjs --check`와 `node --test deploy/platform/mesh/test/*.test.mjs`가 부르는 쪽 목록과 생성물을 본다.
