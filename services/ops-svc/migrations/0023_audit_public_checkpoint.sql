-- BAT-360 OPS-280: 감사 공개 체크포인트의 표준 맞춤(ADR-0348, docs/data.md audit_checkpoint·audit_signing_key, docs/features/control-tower.md §7).
-- ① audit_checkpoint: 공개 번호 no(1부터 빈틈 없음, 유일), 잎 수, 종류(DAILY·EVENT_CLOSE·MANUAL·EXECUTION), 일 앵커, 마감 회차, RFC 8785 JSON 글과 그 해시,
--    공개 타임스탬프 상태·증명 파일·다시 받은 시각, 두 버킷에 게시한 시각. 0023 이전 옛 행은 kind가 비어 legacy(공개 사슬 밖)다.
--    공개 종류는 번호·JSON·해시·잎 수가 꼭 있고, 실행 앞뒤(EXECUTION)는 번호가 없다(내부용).
-- ② audit_signing_key: 체크포인트 서명 키의 공개키(SPKI)와 알고리즘(ADR-0348 결정 4).
-- ③ ops_audit_anchor: 게시 작업 audit-anchor의 DB 역할. audit_chain·audit_chain_head 읽기와 audit_checkpoint·audit_signing_key 넣기·고치기만 갖는다
--    (감사 체인에 기록을 더하지 못한다, ADR-0348 결정 11). 로그인 사용자는 비밀 관리가 만들어 이 역할에 넣는다.
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS no bigint;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS leaf_count integer;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS kind text;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS access_log_day_anchor bytea;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS closed_events jsonb;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS checkpoint_json text;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS checkpoint_hash bytea;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS ots_state text;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS ots_proof bytea;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS ots_upgraded_at timestamptz;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS published_at timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS audit_checkpoint_no_key ON audit_checkpoint (no) WHERE no IS NOT NULL;
--> statement-breakpoint
ALTER TABLE audit_checkpoint DROP CONSTRAINT IF EXISTS audit_checkpoint_kind_check;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD CONSTRAINT audit_checkpoint_kind_check CHECK (kind IS NULL OR kind IN ('DAILY', 'EVENT_CLOSE', 'MANUAL', 'EXECUTION'));
--> statement-breakpoint
ALTER TABLE audit_checkpoint DROP CONSTRAINT IF EXISTS audit_checkpoint_public_check;
--> statement-breakpoint
-- 공개 종류는 번호·JSON·해시·잎 수(= 구간 길이)가 있고, 옛 행·실행 앞뒤 행은 번호가 없다
ALTER TABLE audit_checkpoint ADD CONSTRAINT audit_checkpoint_public_check CHECK (
  CASE
    WHEN kind IN ('DAILY', 'EVENT_CLOSE', 'MANUAL') THEN
      no IS NOT NULL AND no >= 1 AND checkpoint_json IS NOT NULL AND checkpoint_hash IS NOT NULL AND leaf_count IS NOT NULL AND leaf_count = to_seq - from_seq + 1
    ELSE no IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE audit_checkpoint DROP CONSTRAINT IF EXISTS audit_checkpoint_ots_state_check;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD CONSTRAINT audit_checkpoint_ots_state_check CHECK (ots_state IS NULL OR (ots_state IN ('PENDING', 'COMPLETE') AND ots_proof IS NOT NULL));
--> statement-breakpoint
-- 게시는 서명과 증명 파일이 있는 공개 행만
ALTER TABLE audit_checkpoint DROP CONSTRAINT IF EXISTS audit_checkpoint_published_check;
--> statement-breakpoint
ALTER TABLE audit_checkpoint ADD CONSTRAINT audit_checkpoint_published_check CHECK (published_at IS NULL OR (no IS NOT NULL AND signature IS NOT NULL AND ots_state IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_checkpoint_unpublished_idx ON audit_checkpoint (no) WHERE no IS NOT NULL AND published_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_checkpoint_ots_pending_idx ON audit_checkpoint (no) WHERE ots_state = 'PENDING';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_signing_key (
  key_id text PRIMARY KEY,
  public_key_spki bytea NOT NULL,
  alg text NOT NULL,
  first_used_at timestamptz NOT NULL,
  CONSTRAINT audit_signing_key_alg_check CHECK (alg = 'ECDSA_P256_SHA256')
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_audit_anchor') THEN
    CREATE ROLE ops_audit_anchor NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_audit_anchor' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ops_audit_anchor 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ops_audit_anchor;
--> statement-breakpoint
GRANT SELECT ON audit_chain, audit_chain_head TO ops_audit_anchor;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON audit_checkpoint, audit_signing_key TO ops_audit_anchor;
--> statement-breakpoint
-- 리뷰 RV-01(2026-11-22, ADR-0348 결정 1·4·11, docs/data.md audit_checkpoint.signature '게시 작업만 채운다'):
-- API 역할 ops_app은 공개 사슬의 서명 루트를 바꾸지 못한다. 0015의 표 전체 권한을 거두고 필요한 칸만 준다.
-- ① 서명 키 표: 읽기만 한다(키를 넣거나 고치거나 지우는 것은 게시 작업 ops_audit_anchor 몫).
REVOKE INSERT, UPDATE, DELETE ON audit_signing_key FROM ops_app;
--> statement-breakpoint
GRANT SELECT ON audit_signing_key TO ops_app;
--> statement-breakpoint
-- ② 공개 체크포인트 표: 만드는 문장에 필요한 칸만 넣을 수 있고, 서명·키 ID·공개 타임스탬프·게시 칸(signature·key_id·ots_state·ots_proof·
--    ots_upgraded_at·published_at·anchor_ref·anchored_at)은 넣지도 고치지도 못한다. API는 체크포인트 행을 고치는 길이 없으므로 UPDATE도 주지 않는다.
--    칸 권한은 표 권한보다 좁으므로 표 INSERT·UPDATE를 먼저 거둔다(표 권한이 있으면 칸 권한이 무시된다).
REVOKE INSERT, UPDATE ON audit_checkpoint FROM ops_app;
--> statement-breakpoint
GRANT INSERT (id, from_seq, to_seq, root_hash, prev_hash, reason, actor_ref, created_at,
               no, leaf_count, kind, access_log_day_anchor, closed_events, checkpoint_json, checkpoint_hash)
  ON audit_checkpoint TO ops_app;
