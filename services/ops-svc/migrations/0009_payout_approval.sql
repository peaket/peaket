-- 지급 묶음 2인 승인 업무(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, settlement §5.1).
-- 요청자(operator)와 승인자(commander)가 다르고, 승인자는 act APPROVAL 재인증을 거친다.
CREATE TABLE IF NOT EXISTS payout_approval (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  pg text NOT NULL,
  pg_store text NOT NULL,
  payout_date date NOT NULL,
  amount bigint NOT NULL,
  statement_count integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL',
  requester_id uuid NOT NULL,
  requester_role text NOT NULL,
  approver_id uuid,
  reason_text text NOT NULL DEFAULT '',
  failure text,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  approved_at timestamp with time zone,
  executed_at timestamp with time zone,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT payout_approval_pg_check CHECK (pg IN ('TOSS', 'PORTONE')),
  CONSTRAINT payout_approval_pg_store_check CHECK (pg_store IN ('STANDARD', 'ESCROW')),
  CONSTRAINT payout_approval_status_check CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED')),
  CONSTRAINT payout_approval_amount_check CHECK (amount >= 0 AND statement_count >= 0),
  CONSTRAINT payout_approval_version_check CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS payout_approval_status_idx ON payout_approval (status, created_at);
CREATE INDEX IF NOT EXISTS payout_approval_batch_idx ON payout_approval (batch_id);
