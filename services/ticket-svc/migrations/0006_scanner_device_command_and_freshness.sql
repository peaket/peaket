-- BAT-450 GAT-220 잔여: ops-svc 이관용 기기 명령 멱등 기록과 변경분 수신 시각(O-T20).
-- ops-svc가 ScannerDeviceService gRPC로 보내는 등록·폐기·등록 코드 재발급은 request_id 하나를 한 번만 처리한다(ADR-0148).
-- last_changes_at은 스캐너가 마지막으로 변경분을 받은 시각이다. 2분 넘게 없으면 ticket-svc 신선도 감시가 ops-svc SEV2 경보를 낸다.
ALTER TABLE scanner_device ADD COLUMN IF NOT EXISTS last_changes_at timestamptz;

CREATE TABLE IF NOT EXISTS scanner_device_command (
  request_id uuid PRIMARY KEY,
  action text NOT NULL,
  device_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT scanner_device_command_action_check CHECK (action IN ('REGISTER', 'REVOKE', 'REISSUE'))
);

CREATE INDEX IF NOT EXISTS scanner_device_command_device_idx ON scanner_device_command (device_id, created_at);
