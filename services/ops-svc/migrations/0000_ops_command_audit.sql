-- ops-svc 최소 골격(GAT-110 첫 몫, R-552).
-- 운영 명령의 지금 상태 투영(ops_command)과 덧붙이기만 하는 사건(command_event), 2인 승인(command_approval),
-- 불변 감사 로그의 해시 체인(audit_chain·audit_chain_head), CS 처리함 건(cs_case)을 만든다.
-- 정본은 docs/data.md command_event·command_approval·audit_chain·audit_chain_head·cs_case이다. 이 골격은 그 가운데
-- 명령 접수·승인·감사에 필요한 최소 칸만 둔다(제어 gRPC 전달·ack·되돌리기·사후 검토는 후속).

CREATE TABLE IF NOT EXISTS ops_command (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  state text NOT NULL,
  reason text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  requested_role text NOT NULL,
  event_id uuid,
  approval_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT ops_command_state_check CHECK (state IN ('DRAFTED', 'DRY_RUN', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISPATCHED', 'ACKED', 'FAILED', 'REVERT_PENDING', 'REVERTED', 'AUTO_EXPIRED')),
  CONSTRAINT ops_command_type_check CHECK (type IN ('ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'DEGRADED_MODE', 'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN'))
);
CREATE INDEX IF NOT EXISTS ops_command_created_idx ON ops_command (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ops_command_state_idx ON ops_command (state, created_at DESC);

CREATE TABLE IF NOT EXISTS command_event (
  command_id uuid NOT NULL REFERENCES ops_command(id),
  seq integer NOT NULL,
  type text NOT NULL,
  actor_ref text NOT NULL,
  actor_role text NOT NULL,
  reason text NOT NULL,
  dry_run jsonb,
  acked_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (command_id, seq)
);

CREATE TABLE IF NOT EXISTS command_approval (
  command_id uuid NOT NULL REFERENCES ops_command(id),
  approver_ref text NOT NULL,
  approver_role text NOT NULL,
  decision text NOT NULL,
  reason text,
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (command_id, approver_ref),
  CONSTRAINT command_approval_decision_check CHECK (decision IN ('APPROVED', 'REJECTED'))
);

CREATE TABLE IF NOT EXISTS audit_chain (
  seq bigint PRIMARY KEY,
  record_type text NOT NULL,
  record_id uuid NOT NULL,
  record_sha256 bytea NOT NULL,
  mac bytea,
  leaf_salt bytea NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_chain_head (
  id smallint PRIMARY KEY,
  last_seq bigint NOT NULL,
  last_hash bytea NOT NULL,
  CONSTRAINT audit_chain_head_one CHECK (id = 1)
);
INSERT INTO audit_chain_head (id, last_seq, last_hash) VALUES (1, 0, '\x'::bytea) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cs_case (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  target_ref text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT cs_case_status_check CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'))
);
CREATE UNIQUE INDEX IF NOT EXISTS cs_case_open_key ON cs_case (kind, target_ref) WHERE status <> 'RESOLVED';
