-- F-02-4 접속기록 보존 만료 파기 사용자(BUILD_ORDER OPS-330).
-- 정본: docs/data.md §1 '시스템 접속기록', docs/observability.md §7 '법정 사본은 잃지 않는 갈래'·§9,
-- docs/security/data-classification.md '법정 접속기록'·'백업 보존 상한과 파기'.
-- 비밀 값은 이 파일에 두지 않는다. INF-020이 External Secrets로 환경 변수를 채운 뒤 envsubst로 적용한다.
--   PEAKET_AL_PURGER_PASSWORD
-- al_purger는 만료된 하루 파티션을 지우는 잡만 쓴다. 접속기록 행 SELECT·INSERT와 다른 DB 권한은 주지 않는다.
-- TTL은 보조이고, 이 잡이 3개월이 지난 날짜 파티션을 확정적으로 지운다(ADR-0173 결정 7).
CREATE USER IF NOT EXISTS al_purger IDENTIFIED WITH sha256_password BY '${PEAKET_AL_PURGER_PASSWORD}';

GRANT ALTER ON access_log.access_log TO al_purger;
GRANT ALTER ON access_log.access_log_otel TO al_purger;
GRANT SELECT ON system.parts TO al_purger;

-- 파기 기록(ACCESS_LOG_PARTITION_PURGE)은 ops-svc 감사 접수 경로가 받는다.
-- al_purger는 ops DB 자격을 받지 않고, 실행기(tools/local/access-log-jobs.mjs)가 내부 토큰으로 접수한다.
-- 이 파일은 표를 만들거나 지우지 않는다. 표·TTL 변경은 al_migrator만 한다(002_users.sql).
