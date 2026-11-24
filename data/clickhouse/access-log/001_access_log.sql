-- 법정 접속기록 DB 표(docs/data.md §1 '시스템 접속기록', docs/observability.md §7, docs/infra.md §6).
-- 표 이름 access_log는 소유자 결정(2026-11-11, open-items 101번)이다.
-- 수집기(ClickHouse exporter)는 자기 고정 칸을 가진 원천 표 access_log_otel에 넣고, materialized view가 계약 칸 access_log로 옮긴다.
-- 이렇게 해야 create_schema: false에서도 exporter INSERT가 표 칸과 어긋나지 않는다(IR-04).
-- 하루 파티션 하나가 일 해시 앵커·3개월 보존·하루 사본의 단위다(파티션 약 92개).
-- 쓰기는 에이전트 수집기의 clickhouse 내보내기만 하고, 원문 IP는 이 표와 조사 저장소 inv에만 둔다.
CREATE DATABASE IF NOT EXISTS access_log;

-- 1) exporter가 INSERT하는 원천 표. 칸 이름·형은 수집기 0.165.0 clickhouseexporter의 logs_table.sql과 같아야 한다.
CREATE TABLE IF NOT EXISTS access_log.access_log_otel
(
    Timestamp DateTime64(9),
    TraceId String,
    SpanId String,
    TraceFlags UInt8,
    SeverityText LowCardinality(String),
    SeverityNumber UInt8,
    ServiceName LowCardinality(String),
    Body String,
    ResourceSchemaUrl LowCardinality(String),
    ResourceAttributes Map(LowCardinality(String), String),
    ScopeSchemaUrl LowCardinality(String),
    ScopeName String,
    ScopeVersion LowCardinality(String),
    ScopeAttributes Map(LowCardinality(String), String),
    LogAttributes Map(LowCardinality(String), String),
    EventName String
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/access_log_otel', '{replica}')
PARTITION BY toDate(Timestamp)
ORDER BY (toStartOfFiveMinutes(Timestamp), ServiceName, Timestamp)
TTL toDate(Timestamp) + INTERVAL 3 MONTH
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1;

-- 2) 계약 칸 표. 조회·사본·권한·보존은 이 표를 본다. 원문 IP는 모양이 틀린 값 한 줄이 큐를 막지 않게 Nullable(IPv6)로 받는다.
CREATE TABLE IF NOT EXISTS access_log.access_log
(
    ts DateTime64(3, 'UTC'),
    source LowCardinality(String),
    gateway LowCardinality(String),
    request_id String,
    method LowCardinality(String),
    path String,
    status Nullable(UInt16),
    duration_ms Nullable(UInt32),
    client_ip Nullable(IPv6),
    user_agent String,
    account_id String,
    event LowCardinality(String),
    result LowCardinality(String),
    provider LowCardinality(String),
    factors Array(String),
    failure LowCardinality(String),
    act LowCardinality(String),
    seq Nullable(UInt64),
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

-- 3) 원천 표 → 계약 표. LogAttributes는 수집기가 snake_case로 정규화한 값을 담는다.
CREATE MATERIALIZED VIEW IF NOT EXISTS access_log.access_log_from_otel
TO access_log.access_log
AS
SELECT
    Timestamp AS ts,
    LogAttributes['source'] AS source,
    LogAttributes['gateway'] AS gateway,
    LogAttributes['request_id'] AS request_id,
    LogAttributes['method'] AS method,
    LogAttributes['path'] AS path,
    toUInt16OrNull(LogAttributes['status']) AS status,
    toUInt32OrNull(LogAttributes['duration_ms']) AS duration_ms,
    toIPv6OrNull(LogAttributes['client_ip']) AS client_ip,
    LogAttributes['user_agent'] AS user_agent,
    LogAttributes['account_id'] AS account_id,
    LogAttributes['event'] AS event,
    LogAttributes['result'] AS result,
    LogAttributes['provider'] AS provider,
    if(LogAttributes['factors'] = '', [], splitByChar(',', LogAttributes['factors'])) AS factors,
    LogAttributes['failure'] AS failure,
    LogAttributes['act'] AS act,
    toUInt64OrNull(LogAttributes['seq']) AS seq,
    LogAttributes['pod'] AS pod,
    toUInt8OrDefault(LogAttributes['is_admin'], 0) AS is_admin,
    now64(3) AS ingested_at
FROM access_log.access_log_otel;
