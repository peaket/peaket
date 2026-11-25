-- 조사 저장소 `inv`의 ClickHouse 사용자와 권한(docs/data.md '부정 예매 사후 조사의 표' DB 사용자, docs/features/forensic-replay.md §6.7.1, ASVS v5.0.0-13.2.2, F-04-10).
-- - inv_ingest: 적재 작업자 inv-ingest. inv 표에 INSERT만.
-- - inv_reader: ops-svc 조사 모듈. inv에 SELECT만, 읽기 전용 프로필(질의 60초·메모리 4GB [가정]).
-- - inv_purger: 파기 작업 inv-partition-purge. 회차 파티션 DROP만. 결과는 ops DB ops_purge_writer가 따로 남긴다.
-- 비밀번호는 파일에 적지 않는다. migrate 실행기가 {inv_ingest_password} 같은 자리표시자를 환경 값으로 바꾼다.
-- 이 사용자들은 bronze·silver·gold·rt와 다른 데이터베이스에 권한이 없고, 분석 사용자는 inv에 권한이 없다.

CREATE SETTINGS PROFILE IF NOT EXISTS inv_reader_profile SETTINGS readonly = 1, max_execution_time = 60, max_memory_usage = 4294967296;

CREATE USER IF NOT EXISTS inv_ingest IDENTIFIED WITH sha256_password BY '{inv_ingest_password}';
CREATE USER IF NOT EXISTS inv_reader IDENTIFIED WITH sha256_password BY '{inv_reader_password}' SETTINGS PROFILE 'inv_reader_profile';
CREATE USER IF NOT EXISTS inv_purger IDENTIFIED WITH sha256_password BY '{inv_purger_password}';

GRANT INSERT ON inv.* TO inv_ingest;
GRANT SELECT ON inv.* TO inv_reader;
-- ClickHouse 24.12에는 'ALTER DROP PARTITION' 권한이 따로 없다(system.privileges). 파티션 지우기를 포함하는 가장 좁은 권한이 ALTER TABLE이다.
-- 이 사용자는 inv 표에 ALTER TABLE(파티션 지우기·TTL·칼럼 변경)을 할 수 있다. 읽기·넣기는 없다. 좁은 권한이 생기면 그때 바꾼다(F-04-10 계획 §1.2).
GRANT ALTER TABLE ON inv.* TO inv_purger;
