-- 스캐너 목록·변경분·스캔·이상 표시(BUILD_ORDER GAT-180·GAT-190, offline-gate §6.3~§7.2, docs/data.md).
-- 변경 일련번호는 DB 시퀀스가 아니라 회차별 카운터(scanner_seq)를 변경 트랜잭션 안에서 올려 커밋 순서와 같게 한다(ADR-0086).
CREATE TABLE IF NOT EXISTS scanner_seq (
  event_id uuid PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scanner_change (
  event_id uuid NOT NULL,
  seq bigint NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, seq),
  CONSTRAINT scanner_change_kind_check CHECK (kind IN ('KEY_REGISTERED', 'KEY_REVOKED', 'TICKET_STATUS', 'SCAN_STATE', 'POLICY', 'PLACEMENT', 'FLAG', 'SESSION_TERMINATED'))
);

CREATE TABLE IF NOT EXISTS scan_event (
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  scanner_device_id uuid NOT NULL,
  scanner_session_id uuid,
  staff_account_id uuid,
  direction text NOT NULL,
  method text NOT NULL,
  result text NOT NULL,
  reason text,
  gate_zone text NOT NULL DEFAULT '',
  key_id bytea,
  qr_ts timestamptz,
  scanned_at_device timestamptz NOT NULL,
  clock_offset_ms integer,
  known_seq bigint NOT NULL,
  device_seq bigint NOT NULL,
  received_at timestamptz NOT NULL,
  flag text NOT NULL DEFAULT 'NONE',
  PRIMARY KEY (event_id, id),
  CONSTRAINT scan_event_direction_check CHECK (direction IN ('IN', 'OUT')),
  CONSTRAINT scan_event_method_check CHECK (method IN ('QR', 'OVERRIDE', 'VERIFY')),
  CONSTRAINT scan_event_result_check CHECK (result IN ('PASS', 'REJECT', 'CHECK')),
  CONSTRAINT scan_event_flag_check CHECK (flag IN ('NONE', 'DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN'))
);

CREATE UNIQUE INDEX IF NOT EXISTS scan_event_id_key ON scan_event (id);
CREATE INDEX IF NOT EXISTS scan_event_ticket_time_idx ON scan_event (event_id, ticket_id, scanned_at_device, device_seq);

CREATE TABLE IF NOT EXISTS gate_flag (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  kind text NOT NULL,
  awareness text NOT NULL DEFAULT 'CONCURRENT',
  status text NOT NULL DEFAULT 'OPEN',
  resolved_by uuid,
  resolved_at timestamptz,
  note text,
  created_at timestamptz NOT NULL,
  CONSTRAINT gate_flag_kind_check CHECK (kind IN ('DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'OVERRIDE_REVIEW')),
  CONSTRAINT gate_flag_awareness_check CHECK (awareness IN ('CONCURRENT', 'KNOWN')),
  CONSTRAINT gate_flag_status_check CHECK (status IN ('OPEN', 'OK', 'SUSPECT', 'UNDETERMINED'))
);

CREATE INDEX IF NOT EXISTS gate_flag_event_created_idx ON gate_flag (event_id, created_at, id);

CREATE TABLE IF NOT EXISTS gate_flag_scan (
  flag_id uuid NOT NULL,
  scan_event_id uuid NOT NULL,
  PRIMARY KEY (flag_id, scan_event_id)
);
