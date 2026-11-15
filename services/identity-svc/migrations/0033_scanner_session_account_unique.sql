-- C2-05: 스캐너 세션 '계정당 1개' 불변식을 DB에 둔다(identity §6.1, ADR-0051 결정 4).
-- 기존 데이터는 계정별로 가장 최근 승인 세션 하나만 남기고 나머지를 끝낸 뒤 부분 유일 인덱스를 만든다.
ALTER TABLE scanner_session ADD COLUMN IF NOT EXISTS staff_account_id uuid;

UPDATE scanner_session s
SET staff_account_id = a.account_id
FROM staff_assignment a
WHERE s.staff_assignment_id = a.id AND s.staff_account_id IS NULL;

-- 수락되지 않은 초대(account_id 없음)에 매인 세션은 승인될 수 없으므로 남기지 않는다.
DELETE FROM scanner_session WHERE staff_account_id IS NULL;

UPDATE scanner_session s
SET terminated_at = now()
WHERE s.terminated_at IS NULL
  AND s.id NOT IN (
    SELECT DISTINCT ON (staff_account_id) id
    FROM scanner_session
    WHERE terminated_at IS NULL
    ORDER BY staff_account_id, approved_at DESC, id DESC
  );

ALTER TABLE scanner_session ALTER COLUMN staff_account_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS scanner_session_account_active_key
  ON scanner_session (staff_account_id)
  WHERE terminated_at IS NULL;
