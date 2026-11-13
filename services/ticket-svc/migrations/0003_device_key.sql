-- 입장용 기기 공개키(docs/data.md device_key, offline-gate §2·§3, BUILD_ORDER GAT-140).
-- 티켓당 유효 키 하나(부분 유니크 인덱스), 폐기 키는 revoked_at을 남겨 스캐너 폐기 목록에 싣는다.
CREATE TABLE IF NOT EXISTS device_key (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL,
  key_id bytea NOT NULL,
  public_key bytea NOT NULL,
  reason text NOT NULL,
  registered_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT device_key_reason_check CHECK (reason IN ('ISSUE', 'REISSUE', 'TRANSFER', 'BOOTH')),
  CONSTRAINT device_key_key_id_len CHECK (octet_length(key_id) = 8),
  CONSTRAINT device_key_public_key_len CHECK (octet_length(public_key) = 33)
);

CREATE UNIQUE INDEX IF NOT EXISTS device_key_active_key ON device_key (ticket_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS device_key_ticket_key_idx ON device_key (ticket_id, key_id);
