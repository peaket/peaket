-- BAT-465 R-614: 감사 체인 검증이 기록 내용과 연쇄를 다시 계산하게 한다(B3-H03).
-- record_json은 정규화 기록(recordType·recordId·payload·at)이고, prev_hash는 직전 기록 해시다.
-- 기존 행은 record_json을 복원할 수 없어 NULL로 두며, 검증은 그 구간을 valid:false로 닫는다.
ALTER TABLE audit_chain ADD COLUMN IF NOT EXISTS record_json jsonb;
ALTER TABLE audit_chain ADD COLUMN IF NOT EXISTS prev_hash bytea;

-- 기존 행의 prev_hash는 앞선 해시로 복원할 수 있다(첫 행은 빈 bytea).
UPDATE audit_chain a
SET prev_hash = coalesce(
  (SELECT b.record_sha256 FROM audit_chain b WHERE b.seq < a.seq ORDER BY b.seq DESC LIMIT 1),
  '\x'::bytea
)
WHERE a.prev_hash IS NULL;
