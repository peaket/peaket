-- 브론즈 brz_payment_event → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'orderId') as order_ref,
    JSONExtractString(payload, 'pg') as pg,
    JSONExtractString(payload, 'type') as type,
    JSONExtractInt(payload, 'amount') as amount,
    JSONExtractString(payload, 'payMethodCategory') as pay_method_category,
    JSONExtractString(payload, 'result') as result,
    JSONExtractString(payload, 'failureCategory') as failure_category,
    JSONExtractInt(payload, 'attemptNo') as attempt_no,
    JSONExtractInt(payload, 'latencyMs') as latency_ms,
    JSONExtractInt(payload, 'eventSeq') as event_seq,
    JSONExtractString(payload, 'orderKind') as order_kind
from {{ source('bronze', 'brz_payment_event') }}
where {{ event_filter() }}
