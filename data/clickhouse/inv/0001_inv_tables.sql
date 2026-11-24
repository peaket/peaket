-- 조사 저장소 ClickHouse DB `inv`의 표 넷과 적재 진행 표(docs/data.md '부정 예매 사후 조사의 표', docs/streaming.md §6.4, LCH-240, F-04-10).
-- 운영 모양(ON CLUSTER·ReplicatedReplacingMergeTree)으로 적는다. 한 대짜리 local·ci는 inv-ingest 이전 실행기가
-- ON CLUSTER를 지우고 MergeTree로 바꾼다(services/analytics-ingest/src/migrate.ts와 같은 규칙).
-- 표마다 회차(event_id)로 파티션을 나누고, 행마다 적재 시각(ingested_at)과 보존 끝(retain_until = 그 회차 공연일 + 30일)을 싣는다.
-- TTL은 보조다. 지우기는 파기 작업 inv-partition-purge가 retain_until이 지난 회차 파티션을 DROP PARTITION으로 지운다(ADR-0173 결정 7).
-- 정렬 키는 (event_id, 굵은 칸)이고, 판 칸 ingest_rank = UInt64 최댓값 − 적재 시각 밀리초라 합칠 때 가장 이른 행이 남는다.

CREATE DATABASE IF NOT EXISTS inv ON CLUSTER '{cluster}';

-- 조사 경로를 지난 요청 하나(asyncapi InvestigationRequest)
CREATE TABLE IF NOT EXISTS inv.inv_request ON CLUSTER '{cluster}'
(
    event_id         String,
    request_id       String,
    ts               DateTime64(3),
    ingested_at      DateTime64(3),
    journey_id       String,
    gateway          LowCardinality(String),
    route_kind       LowCardinality(String),
    status           UInt16,
    account_id       String,
    pid              String,
    ip               IPv6,
    asn              UInt32,
    net_class        LowCardinality(String),
    ja4              String,
    edge_bot_labels  Array(String),
    device_ref       String,
    retain_until     DateTime64(3),
    ingest_rank      UInt64
)
ENGINE = ReplicatedReplacingMergeTree(ingest_rank)
PARTITION BY event_id
ORDER BY (event_id, request_id)
TTL toDate(retain_until) + INTERVAL 30 DAY DELETE;

-- 여정의 단계 사건 하나(QUEUE_ENTER·ADMIT·HOLD_TRY·HOLD_END·PAY_TRY·ORDER·SALE·TRANSFER·ENTRY_SCAN·CANCEL)
CREATE TABLE IF NOT EXISTS inv.inv_step ON CLUSTER '{cluster}'
(
    event_id             String,
    source_key           String,
    ts                   DateTime64(3),
    ingested_at          DateTime64(3),
    journey_id           String,
    step                 LowCardinality(String),
    pid                  String,
    account_id           String,
    queue_entry_id       String,
    purchase_session_id  String,
    order_id             String,
    ticket_id            String,
    seat_ids             Array(String),
    held_at              String,
    result               String,
    verify_route         LowCardinality(String),
    payment_method_ref   String,
    card_bin             String,
    ref_missing          UInt8,
    retain_until         DateTime64(3),
    ingest_rank          UInt64
)
ENGINE = ReplicatedReplacingMergeTree(ingest_rank)
PARTITION BY event_id
ORDER BY (event_id, source_key)
TTL toDate(retain_until) + INTERVAL 30 DAY DELETE;

-- 화면별 행동 요약 하나(asyncapi BehaviorSignal). 원시 좌표는 없다.
CREATE TABLE IF NOT EXISTS inv.inv_behavior ON CLUSTER '{cluster}'
(
    event_id                String,
    event_key               String,
    ts                      DateTime64(3),
    ingested_at             DateTime64(3),
    journey_id              String,
    pid                     String,
    screen                  LowCardinality(String),
    device_ref              String,
    ref_missing             UInt8,
    net_class               LowCardinality(String),
    asn                     UInt32,
    v                       UInt16,
    window_ms               UInt32,
    pointer_moves           UInt32,
    pointer_entropy         Nullable(Float32),
    input_interval_mean_ms  Float32,
    input_interval_std_ms   Float32,
    scroll_events           UInt32,
    scroll_distance_px      UInt32,
    retain_until            DateTime64(3),
    ingest_rank             UInt64
)
ENGINE = ReplicatedReplacingMergeTree(ingest_rank)
PARTITION BY event_id
ORDER BY (event_id, event_key)
TTL toDate(retain_until) + INTERVAL 30 DAY DELETE;

-- 여정·사람·계정과 연결 값 하나의 짝(PID·ACCOUNT·DEVICE·CONTACT·PAYMENT_METHOD·IDENTITY_CONFLICT)
CREATE TABLE IF NOT EXISTS inv.inv_link ON CLUSTER '{cluster}'
(
    event_id     String,
    kind         LowCardinality(String),
    value        String,
    account_id   String,
    pid          String,
    journey_id   String,
    source       LowCardinality(String),
    first_seen_at DateTime64(3),
    last_seen_at  DateTime64(3),
    ingested_at   DateTime64(3),
    retain_until  DateTime64(3),
    ingest_rank   UInt64
)
ENGINE = ReplicatedReplacingMergeTree(ingest_rank)
PARTITION BY event_id
ORDER BY (event_id, kind, value, account_id, pid, journey_id)
TTL toDate(retain_until) + INTERVAL 30 DAY DELETE;

-- 적재 진행 표시(inv_ingest_lag_seconds의 원천). 표 넷 밖의 운영 표다(추천 적용 2026-11-24, F-04-10 계획 §1.2).
CREATE TABLE IF NOT EXISTS inv.inv_ingest_progress ON CLUSTER '{cluster}'
(
    topic        LowCardinality(String),
    partition    UInt32,
    offset       UInt64,
    ingested_at  DateTime64(3),
    ingest_rank  UInt64 DEFAULT bitNot(toUInt64(toUnixTimestamp64Milli(ingested_at)))
)
ENGINE = ReplicatedReplacingMergeTree(ingest_rank)
PARTITION BY toYYYYMMDD(ingested_at)
ORDER BY (topic, partition)
TTL toDateTime(ingested_at) + INTERVAL 30 DAY;
