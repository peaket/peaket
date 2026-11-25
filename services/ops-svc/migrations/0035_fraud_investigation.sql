-- F-04-12 부정 예매 사후 조사 표(동결 로컬, LCH-260, ADR-0171·0173).
-- docs/data.md '부정 예매 사후 조사의 표'와 docs/features/forensic-replay.md §6.7을 따른다.
CREATE TABLE IF NOT EXISTS fraud_snapshot (
  event_id uuid NOT NULL,
  version integer NOT NULL,
  frozen_at timestamp with time zone NOT NULL,
  inv_hash bytea NOT NULL,
  table_hashes jsonb NOT NULL,
  prev_hash bytea,
  row_counts jsonb NOT NULL,
  range_from timestamp with time zone,
  late boolean NOT NULL DEFAULT false,
  verify_status text,
  verified_at timestamp with time zone,
  PRIMARY KEY (event_id, version),
  CONSTRAINT fraud_snapshot_verify_status_check CHECK (verify_status IN ('OK', 'MISMATCH'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_cluster_run (
  event_id uuid NOT NULL,
  generation integer NOT NULL,
  attempt integer NOT NULL,
  trigger text NOT NULL,
  failure_reason text,
  snapshot_version integer NOT NULL,
  rule_version text NOT NULL,
  result_fingerprint bytea,
  cluster_count integer,
  status text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  finished_at timestamp with time zone,
  PRIMARY KEY (event_id, generation, attempt),
  CONSTRAINT fraud_cluster_run_status_check CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
  CONSTRAINT fraud_cluster_run_trigger_check CHECK (trigger IN ('SCHEDULED', 'SNAPSHOT', 'AUTO_RETRY', 'MANUAL')),
  CONSTRAINT fraud_cluster_run_failure_reason_check CHECK (failure_reason IN ('SOURCE_READ_FAILED', 'TIMEOUT', 'OTHER'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fraud_cluster_run_event_idx ON fraud_cluster_run (event_id, generation, attempt);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_cluster (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  generation integer NOT NULL,
  rule_version text NOT NULL,
  score_band text NOT NULL,
  account_count integer NOT NULL,
  purchase_count integer NOT NULL,
  limit_per_person integer NOT NULL,
  shared_attributes jsonb NOT NULL,
  signals jsonb NOT NULL,
  snapshot_version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT fraud_cluster_score_band_check CHECK (score_band IN ('HIGH', 'MEDIUM', 'LOW'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fraud_cluster_event_generation_idx ON fraud_cluster (event_id, generation);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_cluster_member (
  cluster_id uuid NOT NULL,
  account_id uuid NOT NULL,
  signals jsonb NOT NULL,
  ticket_count integer NOT NULL,
  added_by text NOT NULL,
  removed_at timestamp with time zone,
  appeal_reason_categories jsonb,
  appeal_requested_at timestamp with time zone,
  appeal_due_at timestamp with time zone,
  lock_expires_at timestamp with time zone,
  appeal_result text NOT NULL,
  action_notified_at timestamp with time zone,
  objection_result text NOT NULL DEFAULT 'NONE',
  objection_received_at timestamp with time zone,
  objection_decision_reason text,
  objection_decided_by uuid,
  objection_decided_at timestamp with time zone,
  objection_appeal_id uuid,
  appeal_decision_reason text,
  appeal_decided_by uuid,
  appeal_decided_at timestamp with time zone,
  appeal_id uuid,
  PRIMARY KEY (cluster_id, account_id),
  CONSTRAINT fraud_cluster_member_added_by_check CHECK (added_by IN ('SYSTEM', 'INVESTIGATOR')),
  CONSTRAINT fraud_cluster_member_appeal_result_check CHECK (appeal_result IN ('NOT_REQUESTED', 'PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  CONSTRAINT fraud_cluster_member_objection_result_check CHECK (objection_result IN ('NONE', 'SUBMITTED', 'ACCEPTED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_case (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL,
  cluster_id uuid NOT NULL UNIQUE,
  status text NOT NULL,
  reason_category text NOT NULL,
  assignee_id uuid NOT NULL,
  appeal_due_at timestamp with time zone,
  cancel_deadline_at timestamp with time zone NOT NULL,
  approval_id uuid,
  investigator_opinion text,
  outcome_label text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL,
  closed_at timestamp with time zone,
  CONSTRAINT fraud_case_status_check CHECK (status IN ('INVESTIGATING', 'APPEAL_PENDING', 'DECISION_PENDING', 'ACTIONED', 'CLEARED', 'OBJECTED', 'REVERSED')),
  CONSTRAINT fraud_case_reason_category_check CHECK (reason_category IN ('MACRO_BOT', 'QUEUE_BYPASS', 'CAPTCHA_BYPASS', 'ACCOUNT_LENDING', 'LIMIT_EVASION')),
  CONSTRAINT fraud_case_outcome_label_check CHECK (outcome_label IN ('BOT', 'HUMAN', 'NONE')),
  CONSTRAINT fraud_case_version_check CHECK (version >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fraud_case_event_status_idx ON fraud_case (event_id, status, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS fraud_case_event (
  case_id uuid NOT NULL REFERENCES fraud_case (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL,
  actor_id uuid,
  note text,
  detail jsonb,
  occurred_at timestamp with time zone NOT NULL,
  PRIMARY KEY (case_id, seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS fraud_case_event_case_seq_idx ON fraud_case_event (case_id, seq);
--> statement-breakpoint
-- 사건 기록은 덧붙이기만 한다. 중간 행을 고치거나 지우면 드러나게 한다.
CREATE OR REPLACE FUNCTION fraud_case_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fraud_case_event is append-only';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fraud_case_event_append_only ON fraud_case_event;
--> statement-breakpoint
CREATE TRIGGER fraud_case_event_append_only BEFORE UPDATE OR DELETE ON fraud_case_event FOR EACH ROW EXECUTE FUNCTION fraud_case_event_append_only();
--> statement-breakpoint
-- 멱등 작업 이름에 조사 경로 셋을 더한다.
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
--> statement-breakpoint
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check CHECK (operation IN ('CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT', 'CREATE_OPS_COMMAND', 'DECIDE_VERIFICATION_APPEAL', 'CREATE_FRAUD_CASE', 'CREATE_FRAUD_APPEAL_REQUEST', 'CREATE_FRAUD_CLUSTER_RUN'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON fraud_snapshot, fraud_cluster_run, fraud_cluster, fraud_cluster_member, fraud_case TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON fraud_case_event TO ops_app;
