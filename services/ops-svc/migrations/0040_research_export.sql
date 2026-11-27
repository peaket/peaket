-- F-04-19 연구 내보내기·가명정보 처리 기록(동결 로컬, LCH-330).
-- 정본: docs/features/forensic-replay.md §6.3·§6.4, docs/data.md pseudonymization_log.
-- 번호는 마이그레이션 0040(동결 로컬). 출시 마이그레이션과 같은 번호를 쓰지 않는다(ADR-0386 결정 5).
CREATE TABLE IF NOT EXISTS research_export (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_by_session_id text NOT NULL,
  created_by_role text NOT NULL,
  from_ms bigint NOT NULL,
  to_ms bigint NOT NULL,
  reason text NOT NULL,
  allowlist_version text NOT NULL,
  key_version text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  ready_at timestamptz,
  expires_at timestamptz NOT NULL,
  row_count integer NOT NULL,
  columns jsonb NOT NULL,
  failure_type text,
  sale_ends_at bigint NOT NULL,
  CONSTRAINT research_export_status_check CHECK (status IN ('PENDING', 'READY', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_export_creator_created_idx ON research_export (created_by, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_export_status_expires_idx ON research_export (status, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS research_export_denial (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  at timestamptz NOT NULL,
  problem_type text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_export_denial_account_at_idx ON research_export_denial (account_id, at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pseudonymization_log (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  purpose text NOT NULL,
  items text NOT NULL,
  key_version text NOT NULL,
  usage jsonb NOT NULL,
  processed_from timestamptz NOT NULL,
  destroy_due_at timestamptz NOT NULL,
  destroyed_at timestamptz,
  CONSTRAINT pseudonymization_log_purpose_check CHECK (purpose IN ('STATISTICS', 'SCIENTIFIC_RESEARCH'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pseudonymization_log_event_purpose_idx ON pseudonymization_log (event_id, purpose);
