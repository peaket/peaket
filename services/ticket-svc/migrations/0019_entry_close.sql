-- 입장 기록 마감(F-05-6, offline-gate §7.3 'GAT-180 마감 규칙', docs/data.md).
-- - scanner_queue_report: 기기·회차마다 마지막 큐 비움 보고 하나를 덮어쓴다(받은 시각은 서버 시각).
-- - entry_close: 회차마다 마감 행 하나. 회차가 기본 키라 여러 파드가 함께 판단해도 하나만 남는다.
--   reason은 ALL_REPORTED(역할 유효 끝 뒤 모두 비웠다고 보고) 또는 TIMEOUT(역할 유효 끝 + 24시간 [가정])이다.
--   core_synced_at은 core-svc event.entry_closed_at에 알린 시각이고, 비면 다음 판단마다 다시 보낸다.
-- - scanner_unreported_case: TIMEOUT 마감 때 보고가 없는 기기마다 한 행. opened_at은 ops-svc CS 처리함이 받은 시각이다.
-- - scan_event.state_seq: 그 기록으로 적은 SCAN_STATE 변경의 일련번호(중복 입장의 몰랐음/알고도 통과를 가른다, §7.1).
CREATE TABLE IF NOT EXISTS scanner_queue_report (
  event_id uuid NOT NULL,
  scanner_device_id uuid NOT NULL,
  pending_uploads integer NOT NULL,
  reported_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, scanner_device_id),
  CONSTRAINT scanner_queue_report_pending_uploads_check CHECK (pending_uploads >= 0)
);

CREATE TABLE IF NOT EXISTS entry_close (
  event_id uuid PRIMARY KEY,
  closed_at timestamptz NOT NULL,
  reason text NOT NULL,
  role_ends_at timestamptz NOT NULL,
  core_synced_at timestamptz,
  CONSTRAINT entry_close_reason_check CHECK (reason IN ('ALL_REPORTED', 'TIMEOUT'))
);

-- core에 아직 알리지 못한 마감 행을 빨리 찾는다(다음 판단마다 다시 보내기).
CREATE INDEX IF NOT EXISTS entry_close_pending_core_sync_idx ON entry_close (closed_at, event_id) WHERE core_synced_at IS NULL;

CREATE TABLE IF NOT EXISTS scanner_unreported_case (
  event_id uuid NOT NULL,
  scanner_device_id uuid NOT NULL,
  event_key uuid NOT NULL,
  created_at timestamptz NOT NULL,
  opened_at timestamptz,
  PRIMARY KEY (event_id, scanner_device_id)
);

-- ops-svc에 아직 보내지 못한 건을 빨리 찾는다.
CREATE INDEX IF NOT EXISTS scanner_unreported_case_pending_idx ON scanner_unreported_case (created_at, event_id, scanner_device_id) WHERE opened_at IS NULL;

ALTER TABLE scan_event ADD COLUMN IF NOT EXISTS state_seq bigint;
