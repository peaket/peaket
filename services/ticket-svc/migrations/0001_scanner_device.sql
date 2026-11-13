-- 스캐너 기기 원장(docs/data.md scanner_device, offline-gate §6.1, BUILD_ORDER GAT-170).
-- 기기 키 DPoP의 공개키 지문(jkt)을 기기에 묶고, 요청마다 ACTIVE를 본다. 등록 코드는 Redis에만 둔다.
CREATE TABLE IF NOT EXISTS scanner_device (
  id uuid PRIMARY KEY,
  promoter_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL,
  credential_type text NOT NULL,
  credential_thumbprint bytea,
  cert_expires_at timestamptz,
  enrolled_by uuid NOT NULL,
  enrolled_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CONSTRAINT scanner_device_status_check CHECK (status IN ('ACTIVE', 'REVOKED', 'RETIRED')),
  CONSTRAINT scanner_device_credential_type_check CHECK (credential_type IN ('DEVICE_KEY', 'MTLS_CERT')),
  CONSTRAINT scanner_device_name_check CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX IF NOT EXISTS scanner_device_credential_key ON scanner_device (credential_thumbprint) WHERE credential_thumbprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS scanner_device_promoter_status_idx ON scanner_device (promoter_id, status, enrolled_at, id);
