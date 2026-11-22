-- 양도 요청·받는 사람 참조·부정 예매 양도 잠금(BUILD_ORDER GAT-050·GAT-055, docs/features/transfer-refund.md §4·§4.1,
-- docs/data.md transfer_offer·fraud_transfer_lock). ticket.status의 TRANSFER_PENDING과 transfer_pending은 0000에 이미 있다.
-- 주문·사건(ops)·계정(identity)은 다른 논리 DB라 외래키를 걸지 않는다(티켓만 같은 DB다).

-- 부정 예매 양도 잠금의 판(ADR-0171). 같은 사건의 더 큰 판만 표에 반영한다(ticket.fraud_lock_case_id와 함께 본다).
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS fraud_lock_version bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS transfer_offer (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  from_account_id uuid NOT NULL,
  to_account_id uuid NOT NULL,
  status text NOT NULL,
  withdraw_reason text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT transfer_offer_status_check CHECK (status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'RECLAIMED')),
  CONSTRAINT transfer_offer_withdraw_reason_check CHECK (
    withdraw_reason IS NULL
    OR withdraw_reason IN ('SENDER', 'ACCOUNT_DELETED', 'DEPOSIT_ERROR', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'FRAUD_LOCK')
  )
);

-- 티켓 하나에 진행 중인 요청은 하나뿐이다(이중 양도 방지, docs/data.md §2).
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offer_open_key ON transfer_offer (ticket_id) WHERE status = 'OFFERED';
-- 만료 작업이 집는 자리(정본 docs/data.md §6 부분 인덱스).
CREATE INDEX IF NOT EXISTS transfer_offer_expires_idx ON transfer_offer (expires_at) WHERE status = 'OFFERED';
CREATE INDEX IF NOT EXISTS transfer_offer_recipient_idx ON transfer_offer (to_account_id, status);
CREATE INDEX IF NOT EXISTS transfer_offer_ticket_idx ON transfer_offer (ticket_id, status);

CREATE TABLE IF NOT EXISTS fraud_transfer_lock (
  case_id uuid NOT NULL,
  event_id uuid NOT NULL,
  account_id uuid NOT NULL,
  locked boolean NOT NULL,
  version bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (case_id, event_id, account_id)
);
