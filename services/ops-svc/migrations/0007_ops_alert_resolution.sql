-- BAT-450 O-T20: 스캐너 변경분 신선도 경보가 다시 동기화되면 풀린다.
-- (event_key, kind) 하나를 한 경보로 두고, 풀린 시각·까닭을 같은 행에 남긴다. 다시 나빠지면 open이 그 행을 다시 연다.
ALTER TABLE ops_alert ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE ops_alert ADD COLUMN IF NOT EXISTS resolved_reason text;
