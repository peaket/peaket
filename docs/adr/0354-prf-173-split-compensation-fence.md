# ADR-0354: PRF-173을 보상 핵심과 CS 건 마감으로 나누고, 빠진 발권 막기 RPC를 HOT-161로 더한다

- **상태**: 채택(2026-11-22, 소유자 승인 "네 그렇게 해주세요"). PRF-173의 선행을 정리하고, WBS·BUILD_ORDER의 분할을 정한다.
- **문제**: PRF-173(보상 세 걸음)은 구간 1의 마지막 코드 묶음인데 두 가지로 막혀 있다. ① BUILD_ORDER BAT-011이 선행으로 적은 GAT-280(CS 처리함 건 요청 계약)이 갈래 3·구간 3의 BAT-460에 있어 아직 시작하지 않았다. ② PRF-173의 두 번째 걸음(`compFence`)이 부를 ticket-svc의 주문 단위 발권 막기 RPC가 없다. WBS 2.8.1(HOT-160)은 그 RPC와 `ticket.proto` 고침을 HOT-160이 한다고 적었으나, BAT-050(HOT-160, R-533)은 `IssueTickets`·`CancelTickets`·`ListTickets`만 만들었다. 그 결과 결제 모델 시험 하네스가 `compFence`를 흉내 내고 있고, 회차 취소는 APPROVED 주문을 열린 주문으로 세어 RUNNING에 붙잡지만 그 주문을 보상할 코드가 없다.
- **결정 1 — PRF-173을 둘로 나눈다**: `PRF-173`은 보상 핵심(보상 시작·발권 막기·결제 취소)만 한다. `CHARGED_ON_CLOSED_ORDER`·`TICKET_NOT_ISSUED` CS 처리함 건과 '시스템 잘못이 확인된 환불'로 닫는 길은 새 단계 `PRF-175`로 뺀다. PRF-175의 선행은 GAT-280이다. BAT-011은 `HOT-161·PRF-173`, 새 배치 `BAT-012`는 `PRF-175`다.
- **결정 2 — HOT-161을 더한다**: ticket-svc `BlockTicketIssuance`(주문 단위 발권 막기) RPC와 `ticket_issue_guard` 표를 HOT-161(0.5일 [가정])로 더한다. HOT-160의 체크는 유지하고, 2.8.1을 다시 `진행`으로 둔다. `BlockTicketIssuance`는 주문 ID로 멱등하고, `IssueTickets`와 같은 주문 잠금 아래에서 이미 만든 티켓을 폐기하며, 막은 뒤의 발권은 `FAILED_PRECONDITION`으로 거절한다. 부르는 쪽은 purchase-svc만이고 내부 토큰·메시 인가로 제한한다.
- **결정 3 — '보상 중'은 주문 상태가 아니라 `order_compensation` 표로 둔다**: 공개 `Order.status` 계약에 `COMPENSATING`을 더하지 않는다. 주문은 보상이 끝날 때 T20으로 한 번만 `COMPENSATED`가 되고, 그 사이 상태·임대·재시도는 `order_compensation` 행이 든다. 까닭: 보상은 짧은 Saga이고, 팬 화면·계약·생성물을 늘리지 않으며, `specs/payment.qnt`의 `COMPENSATING`은 이 표의 `STARTED`·`FENCED`로 옮겨 적을 수 있다.
- **결정 4 — `payment_id`와 `cancellation_id`**: `payment_id`는 그 주문의 마지막 APPROVED `payment_attempt`에서 읽는다. `cancellation_id`는 `compensation:{orderId}`의 UUIDv8로 고정해, 보상이 다시 돌아도 payment-svc `CancelPayment`가 같은 취소로 본다.
- **결과**:
  - WBS 2.8.1 1.0→1.5일, 2.7.1 4.5→4.55일, Phase 2 148.25→148.8일, 합계 567.75→568.3일 [가정].
  - BUILD_ORDER BAT-011의 단계를 `HOT-161·PRF-173`(WBS 0.85일)으로, BAT-012를 `PRF-175`(0.15일)로 더한다. BAT-460의 선행 표시 `(갈래 2)`를 `(갈래 4)`로 고치고, OPS-280·OPS-290은 BAT-360(R-751) 기록에서 체크한다.
  - `docs/review/ledger-notes.md`의 P-T39 ③ 정할 곳을 PRF-173으로, ②·④는 PRF-175로 바꾼다.
  - 회차 취소 실행기는 APPROVED 주문을 보상 대상으로 쓸어 담고, 보상이 끝날 때까지 요청을 RUNNING으로 둔다.
- **남는 한계**: PRF-175는 GAT-280의 CS 건 요청 계약이 생길 때까지 `CHARGED_ON_CLOSED_ORDER`·`TICKET_NOT_ISSUED` 건을 닫지 못한다. 그동안 보상 실패는 `order_compensation`의 `FAILED`와 SEV2 로그로 남고, CS 건은 GAT-280 뒤에 연다.
