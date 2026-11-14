-- BAT-425 GAT-130 잔여: 회차 취소 요청·판정·2인 확정(FR-055, POL-038, ADR-0046).
-- commander 요청 → commander 판정 → 판정자가 아닌 operator·commander 확정. 확정 때 purchase-svc 일괄 환불을 시작한다.
CREATE TABLE IF NOT EXISTS event_cancellation_request (
  request_id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'CANCEL',
  status text NOT NULL,
  reason text NOT NULL,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL,
  fault text,
  judgement_reason text,
  fan_notice_reason text,
  judged_by text,
  judged_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  refund_job_state text,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL,
  CONSTRAINT event_cancellation_request_kind_check CHECK (kind IN ('CANCEL', 'POSTPONE')),
  CONSTRAINT event_cancellation_request_status_check CHECK (status IN ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED')),
  CONSTRAINT event_cancellation_request_fault_check CHECK (fault IS NULL OR fault IN ('ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE')),
  CONSTRAINT event_cancellation_request_version_check CHECK (version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS event_cancellation_request_active_key ON event_cancellation_request (event_id)
  WHERE status IN ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW');
CREATE INDEX IF NOT EXISTS event_cancellation_request_event_idx ON event_cancellation_request (event_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS event_cancellation_request_status_idx ON event_cancellation_request (status, requested_at DESC);
