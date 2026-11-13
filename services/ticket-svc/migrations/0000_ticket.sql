-- ticket-svc 최소 발권·취소 스키마(BUILD_ORDER HOT-160, BAT-050).
-- docs/data.md §2 `ticket`·`ticket_cancellation`의 최소 칸만 둔다. 주문·좌석은 다른 논리 DB라 외래키를 걸지 않는다.
-- 적용: PEAKET_DATABASE_URL=postgres://... node scripts/migrate.mjs

CREATE TABLE IF NOT EXISTS ticket_issue (
  order_id uuid NOT NULL,
  issue_generation bigint NOT NULL,
  event_id uuid NOT NULL,
  payer_account_id uuid NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, issue_generation)
);

CREATE TABLE IF NOT EXISTS ticket (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  payer_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  event_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  gate_zone text NOT NULL DEFAULT '',
  status text NOT NULL,
  issue_generation bigint NOT NULL,
  qr_payload text NOT NULL,
  key_hash text NOT NULL,
  key_revoked_at timestamptz,
  transfer_pending boolean NOT NULL DEFAULT false,
  fraud_lock_case_id uuid,
  version integer NOT NULL DEFAULT 0,
  event_starts_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT ticket_status_check CHECK (status IN ('ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'REFUNDED', 'FLAGGED', 'VOIDED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_order_generation_seat_key ON ticket (order_id, issue_generation, seat_id);
CREATE INDEX IF NOT EXISTS ticket_wallet_idx ON ticket (account_id, created_at, id);
CREATE INDEX IF NOT EXISTS ticket_order_idx ON ticket (order_id, issue_generation);

CREATE TABLE IF NOT EXISTS ticket_cancellation (
  cancellation_id uuid NOT NULL,
  ticket_id uuid NOT NULL REFERENCES ticket(id),
  order_id uuid NOT NULL,
  result text NOT NULL,
  cancelled_at timestamptz NOT NULL,
  PRIMARY KEY (cancellation_id, ticket_id)
);

CREATE INDEX IF NOT EXISTS ticket_cancellation_ticket_idx ON ticket_cancellation (ticket_id);
