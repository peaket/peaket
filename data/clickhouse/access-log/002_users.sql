-- 법정 접속기록 DB 사용자와 권한(docs/data.md §1 '시스템 접속기록', docs/security/secrets-and-keys.md '데이터 저장소 접속 자격 증명').
-- 비밀 값은 이 파일에 두지 않는다. INF-020이 External Secrets로 넣고, 이 파일은 사용자와 권한만 정한다.
--   al_ingest: 에이전트 수집기. INSERT만.
--   al_admin_reader: ops-svc. 관리 계정 줄만(행 정책). 개인 계정 줄은 보이지 않는다.
--   al_investigation: 수사 대응 읽기(개인 계정, POL-025). SELECT만.
--   al_migrator: 표 바꾸기·TTL 변경·지우기만. 평소 읽기·쓰기에는 쓰지 않는다.
--   access-log-export(쓰기)와 access-log-restore(읽기)는 사본 버킷 IAM 역할이고 ClickHouse 사용자가 아니다.
CREATE USER IF NOT EXISTS al_ingest IDENTIFIED WITH sha256_password BY 'change-me-in-inf-020';
CREATE USER IF NOT EXISTS al_admin_reader IDENTIFIED WITH sha256_password BY 'change-me-in-inf-020';
CREATE USER IF NOT EXISTS al_investigation IDENTIFIED WITH sha256_password BY 'change-me-in-inf-020';
CREATE USER IF NOT EXISTS al_migrator IDENTIFIED WITH sha256_password BY 'change-me-in-inf-020';

GRANT INSERT ON access_log.access_log TO al_ingest;

GRANT SELECT ON access_log.access_log TO al_admin_reader;
CREATE ROW POLICY IF NOT EXISTS admin_rows_only ON access_log.access_log FOR SELECT USING is_admin = 1 TO al_admin_reader;

GRANT SELECT ON access_log.access_log TO al_investigation;

GRANT ALTER, DROP, CREATE TABLE ON access_log.* TO al_migrator;

-- TTL을 3개월보다 줄이는 변경은 CI(tools/ci/access-log-config.mjs)가 막는다. 표를 지우는 문장은 al_migrator만 낼 수 있다.
