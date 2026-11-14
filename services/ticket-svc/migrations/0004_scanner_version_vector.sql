-- 스캐너 버전 벡터(GAT-160, offline-gate §6.3): 종류별 마지막 일련번호를 빠르게 찾는 인덱스와
-- 낡은 스냅샷 표시(STALE_VERSION)를 이상 표시·스캔 기록 CHECK에 더한다.
CREATE INDEX IF NOT EXISTS scanner_change_event_kind_seq_idx ON scanner_change (event_id, kind, seq DESC);--> statement-breakpoint
ALTER TABLE scan_event DROP CONSTRAINT IF EXISTS scan_event_flag_check;--> statement-breakpoint
ALTER TABLE scan_event ADD CONSTRAINT scan_event_flag_check CHECK (flag IN ('NONE', 'DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'STALE_VERSION'));--> statement-breakpoint
ALTER TABLE gate_flag DROP CONSTRAINT IF EXISTS gate_flag_kind_check;--> statement-breakpoint
ALTER TABLE gate_flag ADD CONSTRAINT gate_flag_kind_check CHECK (kind IN ('DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'OVERRIDE_REVIEW', 'STALE_VERSION'));
