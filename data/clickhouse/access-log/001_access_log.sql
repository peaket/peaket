-- 법정 접속기록 DB 표(docs/data.md §1 '시스템 접속기록', docs/observability.md §7, docs/infra.md §6).
-- 표 이름 access_log는 소유자 결정(2026-11-11, open-items 101번)이다.
-- 하루 파티션 하나가 일 해시 앵커·3개월 보존·하루 사본의 단위다(파티션 약 92개).
-- 쓰기는 에이전트 수집기의 clickhouse 내보내기만 하고, 원문 IP는 이 표와 조사 저장소 inv에만 둔다.
CREATE DATABASE IF NOT EXISTS access_log;

CREATE TABLE IF NOT EXISTS access_log.access_log
(
    ts DateTime64(3, 'UTC'),
    source LowCardinality(String),
    gateway LowCardinality(String),
    request_id String,
    method LowCardinality(String),
    path String,
    status UInt16,
    duration_ms UInt32,
    client_ip IPv6,
    user_agent String,
    account_id String,
    event LowCardinality(String),
    result LowCardinality(String),
    provider LowCardinality(String),
    factors Array(String),
    failure LowCardinality(String),
    act LowCardinality(String),
    seq UInt64,
    pod LowCardinality(String),
    is_admin UInt8 DEFAULT 0,
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/access_log', '{replica}')
PARTITION BY toYYYYMMDD(ts)
ORDER BY ts
TTL toDateTime(ts) + INTERVAL 3 MONTH
SETTINGS index_granularity = 8192;

-- 원문 IP 조회용 건너뛰기 색인(4.1.4 [가정])
ALTER TABLE access_log.access_log
    ADD INDEX IF NOT EXISTS idx_client_ip client_ip TYPE bloom_filter GRANULARITY 4;
