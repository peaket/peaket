-- BAT-425 R-558: ops_command.type CHECK에 EVENT_CANCEL을 더한다.
-- 0000은 GAT-110 골격의 유형 목록을 고정했고, 회차 취소 일괄 환불 명령이 새로 생겨 제약을 다시 만든다.
ALTER TABLE ops_command DROP CONSTRAINT IF EXISTS ops_command_type_check;
ALTER TABLE ops_command ADD CONSTRAINT ops_command_type_check CHECK (type IN (
  'ADMISSION_TARGET', 'ADMISSION_PAUSE', 'KILL_SWITCH', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'DEGRADED_MODE',
  'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN', 'EVENT_CANCEL'
));
