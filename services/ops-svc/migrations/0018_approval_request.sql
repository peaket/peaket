-- BAT-615 LCH-070: 공통 승인 업무(approval_request·approval_vote)와 계약 조건 변경 값(promoter_contract_change)
-- (ADR-0320 결정 3, docs/data.md approval_request·approval_vote, ADR-0086).
-- 이 묶음은 CONTRACT_TERMS_CHANGE 한 종류만 만들고, 지급 묶음은 기존 payout_approval 표를 그대로 쓴다(GAT-290에서 합친다).
CREATE TABLE IF NOT EXISTS approval_request (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  target_ref text NOT NULL,
  fraud_action text,
  requested_role text,
  amount bigint,
  reason_code text,
  reason_text text NOT NULL DEFAULT '',
  evidenceChecked text,
  requested_by uuid NOT NULL,
  requester_role text NOT NULL DEFAULT '',
  required_approvals integer NOT NULL DEFAULT 2,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL',
  close_reason text,
  due_at timestamp with time zone,
  approver_id uuid,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT approval_request_kind_check CHECK (kind IN ('SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'TRANSFER_RECLAIM', 'BOOKING_RESTRICTION', 'PAYOUT_BATCH', 'SETTLEMENT_ADJUSTMENT', 'COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE', 'MINOR_CONTRACT_CANCEL', 'SALE_SUSPENSION', 'SALE_RESUMPTION', 'FRAUD_ACTION')),
  CONSTRAINT approval_request_required_check CHECK (required_approvals IN (1, 2)),
  CONSTRAINT approval_request_status_check CHECK (status IN ('REQUESTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ESCALATED', 'EXECUTING', 'DONE', 'FAILED', 'WITHDRAWN', 'EXPIRED')),
  CONSTRAINT approval_request_version_check CHECK (version >= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS approval_request_status_idx ON approval_request (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS approval_request_target_idx ON approval_request (kind, target_ref);
--> statement-breakpoint
-- 한 파트너에 열린 CONTRACT_TERMS_CHANGE는 하나다(두 겹 가드의 다른 한쪽, core.promoter.pending_contract_approval_id와 같은 규칙)
CREATE UNIQUE INDEX IF NOT EXISTS approval_request_contract_open_uq ON approval_request (kind, target_ref)
  WHERE kind = 'CONTRACT_TERMS_CHANGE' AND status IN ('PENDING_APPROVAL', 'EXECUTING', 'FAILED');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS approval_vote (
  request_id uuid NOT NULL REFERENCES approval_request (id),
  approver_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  approved_at timestamp with time zone NOT NULL,
  reason text,
  PRIMARY KEY (request_id, approver_id),
  CONSTRAINT approval_vote_not_requester_check CHECK (approver_id <> requester_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS promoter_contract_change (
  approval_id uuid PRIMARY KEY REFERENCES approval_request (id),
  promoter_id uuid NOT NULL,
  current_commission_rate_bp integer NOT NULL,
  current_guarantee_rate_bp integer NOT NULL,
  current_guarantee_kind text NOT NULL,
  current_valid_from timestamp with time zone NOT NULL,
  requested_commission_rate_bp integer,
  requested_guarantee_rate_bp integer,
  requested_guarantee_kind text,
  reason_text text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  CONSTRAINT promoter_contract_change_rate_check CHECK (
    current_commission_rate_bp BETWEEN 0 AND 10000 AND current_guarantee_rate_bp BETWEEN 0 AND 10000
    AND (requested_commission_rate_bp IS NULL OR requested_commission_rate_bp BETWEEN 0 AND 10000)
    AND (requested_guarantee_rate_bp IS NULL OR requested_guarantee_rate_bp BETWEEN 0 AND 10000)),
  CONSTRAINT promoter_contract_change_kind_check CHECK (
    current_guarantee_kind IN ('DEPOSIT', 'PERFORMANCE_BOND')
    AND (requested_guarantee_kind IS NULL OR requested_guarantee_kind IN ('DEPOSIT', 'PERFORMANCE_BOND')))
);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_request, approval_vote, promoter_contract_change TO ops_app;
