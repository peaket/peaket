-- BAT-465 R-568: 운영 명령 실행·재시도 상태와 감사 체크포인트.
-- ops_command에 실행 시도·결과 칸을 더하고, SUCCEEDED 상태와 SCALE_CHANGE 유형을 제약에 넣는다.
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS executed_at timestamptz;
ALTER TABLE ops_command ADD COLUMN IF NOT EXISTS result jsonb;

ALTER TABLE ops_command DROP CONSTRAINT IF EXISTS ops_command_state_check;
ALTER TABLE ops_command ADD CONSTRAINT ops_command_state_check CHECK (state IN (
  'DRAFTED', 'DRY_RUN', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISPATCHED', 'ACKED', 'SUCCEEDED',
  'FAILED', 'REVERT_PENDING', 'REVERTED', 'AUTO_EXPIRED'
));

ALTER TABLE ops_command DROP CONSTRAINT IF EXISTS ops_command_type_check;
ALTER TABLE ops_command ADD CONSTRAINT ops_command_type_check CHECK (type IN (
  'ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'DEGRADED_MODE',
  'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN', 'EVENT_CANCEL', 'SCALE_CHANGE'
));

CREATE TABLE IF NOT EXISTS audit_checkpoint (
  id uuid PRIMARY KEY,
  from_seq bigint NOT NULL,
  to_seq bigint NOT NULL,
  root_hash bytea NOT NULL,
  prev_hash bytea NOT NULL,
  reason text NOT NULL,
  actor_ref text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT audit_checkpoint_range_check CHECK (from_seq >= 1 AND to_seq >= from_seq)
);
CREATE INDEX IF NOT EXISTS audit_checkpoint_created_idx ON audit_checkpoint (created_at DESC, to_seq DESC);
