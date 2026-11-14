-- BAT-425 GAT-130: 회차 취소 환불 자동 정지·신청 창 닫힘 경보와 수동 재개 명령 유형.
-- purchase-svc가 내부 HTTP /internal/v1/ops-alerts로 보낸 경보를 남긴다. 콘솔 SSE 연결은 후속이다.
ALTER TABLE ops_command DROP CONSTRAINT IF EXISTS ops_command_type_check;
ALTER TABLE ops_command ADD CONSTRAINT ops_command_type_check CHECK (type IN (
  'ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'DEGRADED_MODE',
  'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN',
  'EVENT_CANCEL', 'EVENT_REFUND_PAUSE', 'EVENT_REFUND_RESUME', 'SCALE_CHANGE'
));

CREATE TABLE IF NOT EXISTS ops_alert (
  id uuid PRIMARY KEY,
  event_key text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  source text NOT NULL,
  reason text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  CONSTRAINT ops_alert_severity_check CHECK (severity IN ('SEV1', 'SEV2', 'SEV3'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_alert_event_kind_key ON ops_alert (event_key, kind);
CREATE INDEX IF NOT EXISTS ops_alert_created_idx ON ops_alert (created_at DESC);
