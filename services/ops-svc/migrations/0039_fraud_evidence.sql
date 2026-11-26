-- F-04-14 증거 묶음·관리 연속성·외부 게시물·내보내기(동결 로컬, LCH-290·LCH-300).
-- 정본: docs/data.md evidence_bundle·evidence_custody_log·external_post·evidence_export,
-- docs/features/forensic-replay.md §6.7.6~§6.7.8. 번호는 MIG-01(2026-11-26)로 ops 0039부터 쓴다.
CREATE TABLE IF NOT EXISTS evidence_bundle (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES fraud_case(id),
  event_id uuid NOT NULL,
  status text NOT NULL,
  snapshot_hash bytea NOT NULL,
  manifest_sha256 bytea,
  queries jsonb NOT NULL DEFAULT '{}'::jsonb,
  s3_prefix text NOT NULL,
  hold_reason text NOT NULL,
  hold_end_requested_by uuid,
  hold_end_requested_at timestamptz,
  hold_end_basis text,
  hold_end_confirmed_by uuid,
  hold_ended_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT evidence_bundle_status_check CHECK (status IN ('BUILDING', 'SEALED', 'DISPOSED')),
  CONSTRAINT evidence_bundle_hold_reason_check CHECK (hold_reason IN ('OBJECTION', 'DISPUTE', 'INVESTIGATION')),
  CONSTRAINT evidence_bundle_hold_confirmer_check CHECK (hold_end_confirmed_by IS NULL OR hold_end_requested_by IS NULL OR hold_end_confirmed_by <> hold_end_requested_by)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_bundle_event_created_idx ON evidence_bundle (event_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_bundle_case_idx ON evidence_bundle (case_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_custody_log (
  bundle_id uuid NOT NULL REFERENCES evidence_bundle(id),
  seq integer NOT NULL,
  action text NOT NULL,
  actor_id uuid,
  reason text,
  export_kind text,
  data_request_id uuid,
  prev_hash bytea,
  row_hash bytea NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (bundle_id, seq),
  CONSTRAINT evidence_custody_log_action_check CHECK (action IN ('CREATED', 'SEALED', 'VIEWED', 'EXPORTED', 'HOLD_CHANGED', 'HOLD_END_REQUESTED', 'HOLD_ENDED', 'DISPOSED')),
  CONSTRAINT evidence_custody_log_export_kind_check CHECK (export_kind IN ('AUTHORITY', 'PROMOTER', 'COMPLAINT'))
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION evidence_custody_log_no_update_fn() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evidence_custody_log는 고치거나 지울 수 없습니다';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS evidence_custody_log_no_update ON evidence_custody_log;
--> statement-breakpoint
CREATE TRIGGER evidence_custody_log_no_update BEFORE UPDATE OR DELETE ON evidence_custody_log
FOR EACH ROW EXECUTE FUNCTION evidence_custody_log_no_update_fn();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS external_post (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  url text NOT NULL,
  site text NOT NULL,
  captured_at timestamptz NOT NULL,
  source text NOT NULL,
  report_case_id uuid,
  claimed_seats text,
  posted_at timestamptz,
  mask_regions jsonb NOT NULL DEFAULT '[]'::jsonb,
  capture_key text NOT NULL,
  capture_sha256 bytea NOT NULL,
  scan_status text NOT NULL,
  matched_ticket_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  registered_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT external_post_source_check CHECK (source IN ('REPORT', 'MANUAL')),
  CONSTRAINT external_post_scan_status_check CHECK (scan_status IN ('PENDING', 'CLEAN', 'THREAT')),
  CONSTRAINT external_post_report_case_check CHECK (source <> 'REPORT' OR report_case_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_post_event_created_idx ON external_post (event_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_export (
  id uuid PRIMARY KEY,
  bundle_id uuid NOT NULL REFERENCES evidence_bundle(id),
  kind text NOT NULL,
  data_request_id uuid,
  document_id uuid,
  sha256 bytea NOT NULL,
  rows integer NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT evidence_export_kind_check CHECK (kind IN ('AUTHORITY', 'PROMOTER', 'COMPLAINT')),
  CONSTRAINT evidence_export_authority_request_check CHECK (kind <> 'AUTHORITY' OR data_request_id IS NOT NULL),
  CONSTRAINT evidence_export_rows_check CHECK (rows >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_export_actor_created_idx ON evidence_export (actor_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_export_bundle_idx ON evidence_export (bundle_id);
--> statement-breakpoint
-- 이 기능의 멱등 작업 이름을 더한다(0014·0035·0037의 검사 목록).
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
--> statement-breakpoint
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check CHECK (operation IN (
  'CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT',
  'CREATE_OPS_COMMAND', 'DECIDE_VERIFICATION_APPEAL', 'CREATE_FRAUD_CASE', 'CREATE_FRAUD_APPEAL_REQUEST',
  'CREATE_FRAUD_CLUSTER_RUN', 'CREATE_FRAUD_ACTION_REQUEST', 'CLEAR_FRAUD_CASE',
  'CREATE_EVIDENCE_BUNDLE', 'CHANGE_EVIDENCE_HOLD', 'REQUEST_EVIDENCE_HOLD_END', 'CONFIRM_EVIDENCE_HOLD_END',
  'CREATE_EVIDENCE_EXPORT', 'CREATE_EXTERNAL_POST'
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON evidence_bundle TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON evidence_custody_log TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON external_post TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON evidence_export TO ops_app;
