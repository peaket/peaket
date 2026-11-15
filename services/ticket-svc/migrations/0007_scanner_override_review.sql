-- R-609 C1-01: 예외 통과(OVERRIDE)의 메모와 사후 검토 표시를 남긴다(offline-gate §7.2, O-T34/ASVS 6.3.4).
-- 예외 통과는 gate_lead 본인 세션만 받고, 모든 OVERRIDE에 OVERRIDE_REVIEW 이상 표시를 만든다.
ALTER TABLE scan_event ADD COLUMN IF NOT EXISTS override_note text;--> statement-breakpoint
ALTER TABLE scan_event DROP CONSTRAINT IF EXISTS scan_event_override_note_check;--> statement-breakpoint
ALTER TABLE scan_event ADD CONSTRAINT scan_event_override_note_check CHECK (override_note IS NULL OR char_length(override_note) <= 100);--> statement-breakpoint
ALTER TABLE scan_event DROP CONSTRAINT IF EXISTS scan_event_flag_check;--> statement-breakpoint
ALTER TABLE scan_event ADD CONSTRAINT scan_event_flag_check CHECK (flag IN ('NONE', 'DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'OVERRIDE_REVIEW', 'STALE_VERSION'));--> statement-breakpoint
ALTER TABLE gate_flag DROP CONSTRAINT IF EXISTS gate_flag_kind_check;--> statement-breakpoint
ALTER TABLE gate_flag ADD CONSTRAINT gate_flag_kind_check CHECK (kind IN ('DUPLICATE', 'NO_EXIT', 'AFTER_CANCEL', 'OUT_OF_SESSION', 'AFTER_CLOSE', 'TIME_UNCERTAIN', 'OVERRIDE_REVIEW', 'STALE_VERSION'));
