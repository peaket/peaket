-- BAT-045 BOT-152: 관제 관리 계정의 commander 역할 변경 승인 업무가 쓰는 칸을 더한다.
-- 표와 approval_vote는 BAT-615의 0018_approval_request.sql이 이미 만든다(같은 표를 두 저장소가 함께 쓴다).
-- 그래서 여기서는 CREATE TABLE을 하지 않고, BAT-045가 읽고 쓰는 from_role·target_version만 더한다.
-- kind CHECK는 0018 목록에 COMMANDER_ROLE_CHANGE가 이미 있지만, 0018이 먼저 적용된 DB와 새 DB 모두에서
-- 같은 목록이 되도록 다시 건다(CONTRACT_TERMS_CHANGE 유지).
-- due_at은 요청 뒤 5영업일 [가정]을 ops-svc가 계산해 넣는다(표 기본값으로는 영업일을 셀 수 없다).
-- target_version은 승인 때 다시 보는 대상 계정의 판(If-Match)이고, from_role은 권한 변경 내역의 이전 역할이다.
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS from_role text;
--> statement-breakpoint
ALTER TABLE approval_request ADD COLUMN IF NOT EXISTS target_version bigint NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE approval_request DROP CONSTRAINT IF EXISTS approval_request_kind_check;
--> statement-breakpoint
ALTER TABLE approval_request ADD CONSTRAINT approval_request_kind_check CHECK (kind IN (
  'SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'TRANSFER_RECLAIM', 'BOOKING_RESTRICTION', 'PAYOUT_BATCH',
  'SETTLEMENT_ADJUSTMENT', 'COMMANDER_ROLE_CHANGE', 'CONTRACT_TERMS_CHANGE', 'MINOR_CONTRACT_CANCEL',
  'SALE_SUSPENSION', 'SALE_RESUMPTION', 'FRAUD_ACTION'
));
--> statement-breakpoint
ALTER TABLE approval_request ALTER COLUMN due_at DROP NOT NULL;
--> statement-breakpoint
-- 권한 변경 내역(SCR-064 ⑥)은 이 계정의 감사 기록을 최근 순으로 읽는다. 시험은 record_id=대상 계정 ID를 쓴다.
CREATE INDEX IF NOT EXISTS audit_chain_record_seq_idx ON audit_chain (record_id, seq DESC);
