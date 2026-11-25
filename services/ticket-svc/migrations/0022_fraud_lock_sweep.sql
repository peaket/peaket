-- F-04-13 ticket-svc 부정 예매 양도 잠금 만료 정비(동결 로컬, LCH-270·LCH-280, FX-T15).
-- 정본: docs/features/forensic-replay.md §6.7.4 C13·C17, docs/features/transfer-refund.md §4.1.
-- 60초 정비가 만료된 잠금을 훑고, 표에서 잠금 흔적을 지울 때 쓰는 인덱스다.
CREATE INDEX IF NOT EXISTS fraud_transfer_lock_expires_idx ON fraud_transfer_lock (expires_at) WHERE locked;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ticket_fraud_lock_idx ON ticket (event_id, payer_account_id) WHERE fraud_lock_case_id IS NOT NULL;
