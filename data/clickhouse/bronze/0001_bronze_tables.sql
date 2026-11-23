-- 분석 브론즈 표(docs/features/analytics.md §3·§5.5, docs/streaming.md §6, OPS-200·OPS-205, F-04-3).
-- 운영 모양(ON CLUSTER·ReplicatedMergeTree)으로 적는다. 한 대짜리 local·ci는 analytics-ingest 이전 실행기가 ON CLUSTER를 지우고 MergeTree로 바꾼다.
-- 사건 브론즈는 레코드마다 표 하나이고 칸은 공통 머리 + 가명·허용 목록을 거친 값 payload(JSON 글)다(추천 적용 2026-11-23, F-04-3 계획:
-- 원문 보관층이라 칸을 계약 판마다 펼치지 않고 실버(dbt, F-04-4)가 JSON에서 꺼낸다). 조사 칸(journey_id 등)은 열로도 값으로도 없다(A-T21).
-- 정렬 (event_id, occurred_at), 적재 날짜 파티션, 적재 뒤 90일(가명정보 처리 기간, analytics §5.5). 중복을 허용한다(실버가 eventKey로 지운다).

CREATE DATABASE IF NOT EXISTS bronze ON CLUSTER '{cluster}';

-- OrderEvent
CREATE TABLE IF NOT EXISTS bronze.brz_order_event ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- PaymentEvent
CREATE TABLE IF NOT EXISTS bronze.brz_payment_event ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- SeatEvent
CREATE TABLE IF NOT EXISTS bronze.brz_seat_event ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- EventSaleChanged
CREATE TABLE IF NOT EXISTS bronze.brz_event_sale ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- PurchaseSessionStarted·PurchaseSessionEnded
CREATE TABLE IF NOT EXISTS bronze.brz_purchase_session ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- TicketEvent
CREATE TABLE IF NOT EXISTS bronze.brz_ticket_event ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- SettlementEvent
CREATE TABLE IF NOT EXISTS bronze.brz_settlement_event ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- SettingChanged(actor 없음)
CREATE TABLE IF NOT EXISTS bronze.brz_setting_changed ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- QueueEntryRecord
CREATE TABLE IF NOT EXISTS bronze.brz_queue_entry ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- HoldAttempt
CREATE TABLE IF NOT EXISTS bronze.brz_hold_attempt ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- TrustVerdict
CREATE TABLE IF NOT EXISTS bronze.brz_trust_verdict ON CLUSTER '{cluster}'
(
    event_id         String,
    event_key        UUID,
    record           LowCardinality(String),
    occurred_at      DateTime64(3),
    key_version      LowCardinality(String),
    schema_id        UInt32,
    payload          String,
    kafka_topic      LowCardinality(String),
    kafka_partition  UInt32,
    kafka_offset     UInt64,
    kafka_ts         DateTime64(3),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMMDD(loaded_at)
ORDER BY (event_id, occurred_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- 적재 거절 기록(docs/streaming.md §6.3 그대로). 원문 없이 위치만
CREATE TABLE IF NOT EXISTS bronze.brz_rejected ON CLUSTER '{cluster}'
(
    topic        LowCardinality(String),
    partition    UInt32,
    offset       UInt64,
    kafka_ts     DateTime64(3),
    schema_id    Nullable(UInt32),
    error_class  LowCardinality(String),
    loaded_at    DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
ORDER BY (topic, partition, offset)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- 커버리지 위치 표(analytics §7 커버리지, 추천 적용 2026-11-23, F-04-3 계획): 받은 모든 레코드의 위치와 결과(LOADED·REJECTED·SKIPPED).
-- 건너뛴 심장 박동·1초 집계·점검 회차도 위치가 남아 '고유한 (파티션, 오프셋) 수 = 구간 길이' 대조가 바로 된다
CREATE TABLE IF NOT EXISTS bronze.brz_offset ON CLUSTER '{cluster}'
(
    topic      LowCardinality(String),
    partition  UInt32,
    offset     UInt64,
    outcome    LowCardinality(String),
    reason     LowCardinality(String),
    loaded_at  DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
ORDER BY (topic, partition, offset)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

-- 회차 기준 자료(analytics §3.2 칸 이름 그대로, 소유자 결정 2026-11-11 open-items 101번 ⑽). 싣는 것은 마감 실행기(F-04-6)다.
-- brz_ref_seat_map은 관제 실시간 표 잔여석 계산(an_rt_reader, force_primary_key)이 회차로 읽으므로 event_id가 정렬 키 앞이다(F-04-1 계획 '남긴 것')
CREATE TABLE IF NOT EXISTS bronze.brz_ref_event ON CLUSTER '{cluster}'
(
    event_id         String,
    production_id    String,
    production_name  String,
    genre            LowCardinality(String),
    venue_id         String,
    venue_name       String,
    starts_at        DateTime64(3),
    open_at          DateTime64(3),
    sale_end_at      Nullable(DateTime64(3)),
    seat_count       UInt32,
    sale_policy      String,
    promoter_name    String,
    size_grade       LowCardinality(String),
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
ORDER BY (event_id, loaded_at)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS bronze.brz_ref_seat_map ON CLUSTER '{cluster}'
(
    event_id         String,
    layout_version   UInt32,
    section_id       String,
    section_name     String,
    tier_id          LowCardinality(String),
    price            Int64,
    seat_count       UInt32,
    seat_index_from  UInt32,
    seat_index_to    UInt32,
    loaded_at        DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedMergeTree
ORDER BY (event_id, layout_version, section_id, tier_id)
TTL toDateTime(loaded_at) + INTERVAL 90 DAY;
