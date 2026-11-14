-- 스캐너 기기 배치와 근무 준비 보고(GAT-170 잔여, offline-gate §6.2, docs/data.md scanner_placement).
-- 배치는 회차·기기마다 하나이고(기본 키 (event_id, scanner_device_id)), 바뀌면 scanner_change(PLACEMENT)로 나간다.
-- 근무 준비 보고는 기기가 마지막으로 보낸 목록 일련번호·시계 오차·업로드 대기 수다(SCR-033, SCR-037 준비 표시).
CREATE TABLE IF NOT EXISTS scanner_placement (
  event_id uuid NOT NULL,
  scanner_device_id uuid NOT NULL,
  gate_zone text NOT NULL,
  mode text NOT NULL,
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT scanner_placement_pkey PRIMARY KEY (event_id, scanner_device_id),
  CONSTRAINT scanner_placement_mode_check CHECK (mode IN ('IN', 'OUT')),
  CONSTRAINT scanner_placement_gate_zone_check CHECK (char_length(gate_zone) BETWEEN 1 AND 80),
  CONSTRAINT scanner_placement_version_check CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS scanner_placement_device_idx ON scanner_placement (scanner_device_id, event_id);

CREATE TABLE IF NOT EXISTS scanner_readiness (
  event_id uuid NOT NULL,
  scanner_device_id uuid NOT NULL,
  package_seq bigint NOT NULL,
  clock_offset_ms integer NOT NULL,
  pending_uploads integer NOT NULL,
  reported_by uuid NOT NULL,
  reported_at timestamptz NOT NULL,
  CONSTRAINT scanner_readiness_pkey PRIMARY KEY (event_id, scanner_device_id),
  CONSTRAINT scanner_readiness_package_seq_check CHECK (package_seq >= 0),
  CONSTRAINT scanner_readiness_pending_uploads_check CHECK (pending_uploads >= 0)
);
