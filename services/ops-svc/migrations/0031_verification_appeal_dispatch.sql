-- F-06-7 GAT-280(ADR-0364 결정 8·9): 추가 검증 이의 건의 내용·결정(verification_case)과 보낼 호출(cs_case_dispatch).
-- 정본은 docs/data.md verification_case·cs_case_dispatch·§5.1 'CS 처리함 보낼 호출' 행, 동작은 docs/features/bot-defense.md §12 'CS 처리 첫 구현'이다.
-- 건을 처음 열 때 같은 트랜잭션에 이의 행(내용 없음)과 보낼 호출 둘(APPEAL_COPY·ACCOUNT_HOLD_OPEN)을 넣고, 결정할 때 건 해결과 같은 트랜잭션에
-- 결정 호출(인정 셋·기각 둘)을 넣는다. 시각 값(next_attempt_at·claimed_until)은 앱 시계로 넣고 SQL 기본값을 쓰지 않는다.
-- pid는 라벨 반영을 다시 보내려고 두되 API 응답·운영 로그·감사 기록에 싣지 않는다(docs/security/data-classification.md).

CREATE TABLE IF NOT EXISTS verification_case (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cs_case (id),
  event_id uuid,
  account_id uuid,
  pid text,
  appeal_text text,
  reason_category text,
  received_at timestamptz,
  status text NOT NULL,
  appeal_result text,
  decided_by uuid,
  decided_at timestamptz,
  block_list_change text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  -- 다섯 값은 소유자 결정(2026-11-11, open-items 101번), 뜻은 data.md verification_case.status
  CONSTRAINT verification_case_status_check CHECK (status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED')),
  CONSTRAINT verification_case_appeal_result_check CHECK (appeal_result IS NULL OR appeal_result IN ('ACCEPTED', 'REJECTED')),
  CONSTRAINT verification_case_block_list_change_check CHECK (block_list_change IS NULL OR block_list_change IN ('NONE', 'ADDED', 'REMOVED', 'DEVICE_NOT_FOUND')),
  -- 이의 글은 NFC 정규화 뒤 0~1,000자(grapheme)다. 글자 하나가 여러 코드 포인트일 수 있어 넉넉히 둔다
  CONSTRAINT verification_case_appeal_text_check CHECK (appeal_text IS NULL OR char_length(appeal_text) <= 8000),
  CONSTRAINT verification_case_decided_check CHECK ((appeal_result IS NULL) = (decided_at IS NULL))
);
-- 건 하나에 이의 하나(이의 ID마다 건 하나와 짝, bot-defense §12 '같은 이의의 다른 건 요청')
CREATE UNIQUE INDEX IF NOT EXISTS verification_case_case_id_key ON verification_case (case_id);

CREATE TABLE IF NOT EXISTS cs_case_dispatch (
  case_id uuid NOT NULL REFERENCES cs_case (id),
  call text NOT NULL,
  source_version bigint NOT NULL,
  state text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  claimed_until timestamptz,
  last_error text,
  result text,
  failed_alerted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cs_case_dispatch_pkey PRIMARY KEY (case_id, call),
  CONSTRAINT cs_case_dispatch_call_check CHECK (call IN ('APPEAL_COPY', 'ACCOUNT_HOLD_OPEN', 'QUEUE_RESOLVE', 'TRUST_LABEL', 'ACCOUNT_HOLD_CLOSE')),
  CONSTRAINT cs_case_dispatch_state_check CHECK (state IN ('PENDING', 'APPLIED', 'FAILED')),
  CONSTRAINT cs_case_dispatch_attempts_check CHECK (attempts >= 0),
  CONSTRAINT cs_case_dispatch_source_version_check CHECK (source_version >= 1),
  CONSTRAINT cs_case_dispatch_last_error_check CHECK (last_error IS NULL OR char_length(last_error) <= 64)
);
-- 보낼 호출 잡기: WHERE state <> 'APPLIED' AND next_attempt_at <= $now … ORDER BY next_attempt_at, case_id LIMIT 50 FOR UPDATE SKIP LOCKED(data.md §5.1)
CREATE INDEX IF NOT EXISTS cs_case_dispatch_due_idx ON cs_case_dispatch (next_attempt_at) WHERE state <> 'APPLIED';

-- 관제 경로·실행기 역할(0015의 기본 권한이 새 표에도 주지만, 기본 권한을 만든 역할과 다를 수 있어 다시 적는다)
GRANT SELECT, INSERT, UPDATE, DELETE ON verification_case, cs_case_dispatch TO ops_app;

-- 결정 멱등 기록은 공용 idempotency_record를 쓴다(0014). 작업 이름을 목록에 더한다(0021까지의 이름은 그대로 둔다)
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check
  CHECK (operation IN ('CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT', 'CREATE_OPS_COMMAND', 'DECIDE_VERIFICATION_APPEAL'));
