-- 부정 예매 운영자 취소의 표별 결과(BUILD_ORDER GAT-080, ticket.proto OperatorCancelTickets, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', docs/data.md ticket_operator_cancellation).
-- 기본 키 (approval_id, ticket_id)가 OperatorCancelTickets의 멱등이다. 건너뜀도 남겨 같은 승인으로 다시 부르면 처음 결과를 준다.
-- 주문(purchase)·사건(ops)은 다른 논리 DB라 외래키를 걸지 않는다. 양도 요청 표(transfer_offer)가 생기기 전이라 withdrawn_transfer_offer_id는 비운다.

CREATE TABLE IF NOT EXISTS ticket_operator_cancellation (
  approval_id uuid NOT NULL,
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  order_id uuid NOT NULL,
  fraud_case_id uuid NOT NULL,
  result text NOT NULL,
  withdrawn_transfer_offer_id text,
  cancelled_at timestamptz NOT NULL,
  PRIMARY KEY (approval_id, ticket_id),
  CONSTRAINT ticket_operator_cancellation_result_check CHECK (result IN ('CANCELED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_RECORDED', 'SKIPPED_HOLDER_CHANGED'))
);
