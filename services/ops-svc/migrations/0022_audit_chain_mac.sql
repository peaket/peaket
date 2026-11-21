-- BAT-355 OPS-270: 감사 체인 mac의 첫 구현(ADR-0341, docs/data.md audit_chain_head·ops_worker_lease·audit_mac_anchor·audit_verification_run·audit_record_intake).
-- ① audit_chain_head: mac을 채운 마지막 seq(mac_seq)와 그 행의 mac(last_mac). 체인 작업자만 올리고 기록 트랜잭션은 읽지 않는다(ADR-0102).
--    이미 있는 행도 작업자가 seq 1부터 채운다(ADR-0341 결정 1).
-- ② audit_chain: mac이 빈 행의 부분 색인(가장 오래된 빈 행의 나이를 10초 [가정]마다 본다, 결정 4).
-- ③ ops_worker_lease: 작업자 하나를 고르는 DB 임대 행(이름 audit-chain-mac, 15초 [가정], 결정 3).
-- ④ audit_mac_anchor: 5분 앵커로 감사 앵커 버킷에 쓴 seq·mac·객체 이름·키 ID(같은 seq는 기본 키가 막는다, 결정 5).
-- ⑤ audit_verification_run: 검증 잡 한 번의 결과(VALID·MISMATCH·ERROR, 결정 6).
-- ⑥ audit_record_intake: 다른 서비스가 보낸 감사 사건의 멱등 키(같은 eventKey는 체인 행 하나, 결정 7).
ALTER TABLE audit_chain_head ADD COLUMN IF NOT EXISTS mac_seq bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE audit_chain_head ADD COLUMN IF NOT EXISTS last_mac bytea NOT NULL DEFAULT '\x'::bytea;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_chain_mac_pending_idx ON audit_chain (seq) WHERE mac IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_worker_lease (
  name text PRIMARY KEY,
  holder text NOT NULL,
  lease_until timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_mac_anchor (
  seq bigint PRIMARY KEY,
  mac bytea NOT NULL,
  object_key text NOT NULL,
  key_id text NOT NULL,
  anchored_at timestamptz NOT NULL,
  CONSTRAINT audit_mac_anchor_seq_check CHECK (seq >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_verification_run (
  run_id uuid PRIMARY KEY,
  from_seq bigint NOT NULL,
  to_seq bigint NOT NULL,
  result text NOT NULL,
  first_bad_seq bigint,
  reason text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  CONSTRAINT audit_verification_run_result_check CHECK (result IN ('VALID', 'MISMATCH', 'ERROR'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_verification_run_valid_idx ON audit_verification_run (to_seq DESC) WHERE result = 'VALID';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_record_intake (
  event_key text PRIMARY KEY,
  seq bigint NOT NULL,
  received_at timestamptz NOT NULL
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ops_worker_lease, audit_mac_anchor, audit_verification_run, audit_record_intake TO ops_app;
