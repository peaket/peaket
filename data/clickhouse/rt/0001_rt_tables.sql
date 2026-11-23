-- 관제 실시간 표의 원시 표 다섯(docs/streaming.md §4.3, OPS-160, F-04-1).
-- 운영 모양(복제본 2벌, ReplicatedMergeTree, ON CLUSTER)으로 적는다. 한 대짜리 로컬·CI ClickHouse에서는 이전 실행기
-- (services/ops-rt/src/migrate.ts)가 'ON CLUSTER' 구를 지우고 ReplicatedMergeTree를 MergeTree로 바꾼다(F-04-1 계획 '추천 적용').
-- 원시 표는 중복을 받아도 된다. 중복은 읽을 때 eventKey로 지운다(§4.3 뷰). 이름과 TTL은 [가정]이다.

CREATE DATABASE IF NOT EXISTS rt ON CLUSTER '{cluster}';

CREATE TABLE IF NOT EXISTS rt.sale_event ON CLUSTER '{cluster}'
(
    event_id        LowCardinality(String),
    event_key       UUID,
    source          LowCardinality(String),   -- SEAT·ORDER·PAYMENT·TICKET
    type            LowCardinality(String),   -- PENDING·SOLD·RETURNED·ACCEPTED·APPROVED·CONFIRMED·DEPOSIT_REVERSED·ISSUED·VOIDED·UNRECOGNIZED
    seat_id         String,                   -- 좌석 사건만, 그 밖은 ''
    tier_id         LowCardinality(String),
    section_id      LowCardinality(String),
    amount          Int64,                    -- 결제 사건만(원), 그 밖은 0
    first_in_stage  Bool,                     -- 주문 사건만
    occurred_at     DateTime64(3),
    kafka_partition UInt32,
    kafka_offset    UInt64,
    loaded_at       DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, source, event_key)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS rt.queue_aggregate ON CLUSTER '{cluster}'
(
    event_id    LowCardinality(String),
    event_key   UUID,
    pod         LowCardinality(String),
    second      DateTime,
    entries     UInt32,
    admissions  UInt32,
    removed     UInt32,
    loaded_at   DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(second)
ORDER BY (event_id, second, event_key)
TTL second + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS rt.hold_attempt ON CLUSTER '{cluster}'
(
    event_id               LowCardinality(String),
    event_key              UUID,
    result                 LowCardinality(String),   -- HELD·CONFLICT·LIMIT·ERROR·RECENTLY_RELEASED·UNRECOGNIZED
    tier_id                LowCardinality(String),
    first_held_in_session  Bool,
    occurred_at            DateTime64(3),
    loaded_at              DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, occurred_at, event_key)
TTL toDateTime(occurred_at) + INTERVAL 400 DAY;

CREATE TABLE IF NOT EXISTS rt.verdict ON CLUSTER '{cluster}'
(
    event_id     LowCardinality(String),
    event_key    UUID,
    category     LowCardinality(String),
    occurred_at  DateTime64(3),
    loaded_at    DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (event_id, occurred_at, event_key)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS rt.pulse ON CLUSTER '{cluster}'
(
    topic            LowCardinality(String),
    kafka_partition  UInt32,
    produced_at      DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(produced_at)
ORDER BY (topic, kafka_partition, produced_at)
TTL toDateTime(produced_at) + INTERVAL 7 DAY;
