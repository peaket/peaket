-- BAT-420 GAT-110: ops-svc 멱등 기록 표(docs/data.md '서비스마다 둔 멱등 기록 표', guidelines §4, platform idempotencyRecordTable 꼴).
-- 범위는 계정 × 작업 × 키다. 작업은 commander 회차 취소 요청과 파트너 회차 취소·연기 요청 둘이다. core-svc 0002의 같은 표를 본떴다.
CREATE TABLE IF NOT EXISTS idempotency_record (
  account_ref text NOT NULL,
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash bytea NOT NULL,
  result_ref text,
  created_at timestamptz NOT NULL,
  CONSTRAINT idempotency_record_account_ref_operation_idempotency_key_pk PRIMARY KEY (account_ref, operation, idempotency_key),
  CONSTRAINT idempotency_record_operation_check CHECK (operation IN ('CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION'))
);
CREATE INDEX IF NOT EXISTS idempotency_record_created_at_idx ON idempotency_record (created_at);
