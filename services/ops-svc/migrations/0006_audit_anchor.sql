-- BAT-465 R-584: 감사 체크포인트의 공개 앵커·Ed25519 서명(ADR-0075, control-tower §7).
-- 서명은 체크포인트 값(판·ID·구간·루트·직전 루트·만든 시각)을 Ed25519로 서명한 base64다. anchor_ref는 공개 앵커의 위치다.
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS signature text;
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS key_id text;
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS anchor_ref text;
ALTER TABLE audit_checkpoint ADD COLUMN IF NOT EXISTS anchored_at timestamptz;
