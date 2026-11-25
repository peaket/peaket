-- F-04-13 FRAUD_ACTION 승인 요약 열람·예매 제한(동결 로컬, LCH-270·LCH-280).
-- 정본: docs/data.md approval_summary_view·booking_restriction, docs/features/forensic-replay.md §6.7.5.
-- 승인자가 사건 요약을 처음 연 시각을 승인자마다 한 번 남긴다. 실행 전 열람 여부를 이 표로 판정한다.
CREATE TABLE IF NOT EXISTS approval_summary_view (
  approval_id uuid NOT NULL REFERENCES approval_request(id),
  admin_account_id uuid NOT NULL,
  first_viewed_at timestamptz NOT NULL,
  PRIMARY KEY (approval_id, admin_account_id)
);
--> statement-breakpoint
-- 부정 예매 이용 제한. 계정마다 판 번호를 올리고, FRAUD 사유와 사건·확인자를 남긴다.
CREATE TABLE IF NOT EXISTS booking_restriction (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  reason_code text NOT NULL,
  fraud_case_id uuid,
  confirmed_by uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  appeal_due_at timestamptz NOT NULL,
  status text NOT NULL,
  version bigint NOT NULL,
  CONSTRAINT booking_restriction_reason_code_check CHECK (reason_code IN ('FRAUD')),
  CONSTRAINT booking_restriction_status_check CHECK (status IN ('ACTIVE', 'LIFTED', 'EXPIRED')),
  CONSTRAINT booking_restriction_version_check CHECK (version >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_restriction_account_status_idx ON booking_restriction (account_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_restriction_case_idx ON booking_restriction (fraud_case_id);
--> statement-breakpoint
-- 조치 요청·이의 판단·정상 종료의 멱등 작업 이름을 더한다(0014·0035의 검사 목록).
ALTER TABLE idempotency_record DROP CONSTRAINT IF EXISTS idempotency_record_operation_check;
--> statement-breakpoint
ALTER TABLE idempotency_record ADD CONSTRAINT idempotency_record_operation_check CHECK (operation IN (
  'CREATE_EVENT_CANCELLATION', 'CREATE_PARTNER_EVENT_CANCELLATION', 'CREATE_BOT_REVIEW_JUDGEMENT',
  'CREATE_OPS_COMMAND', 'DECIDE_VERIFICATION_APPEAL', 'CREATE_FRAUD_CASE', 'CREATE_FRAUD_APPEAL_REQUEST',
  'CREATE_FRAUD_CLUSTER_RUN', 'FRAUD_ACTION_REQUEST', 'CLEAR_FRAUD_CASE'
));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_summary_view TO ops_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON booking_restriction TO ops_app;
