-- 브론즈 brz_order_event → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'orderId') as order_ref,
    JSONExtractString(payload, 'accountId') as account_ref,
    JSONExtractString(payload, 'type') as type,
    JSONExtractInt(payload, 'amount') as amount,
    JSONExtractInt(payload, 'refundAmount') as refund_amount,
    JSONExtractString(payload, 'purchaseSessionId') as purchase_session_ref,
    JSONExtract(payload, 'items', 'Array(Tuple(seatId String, tierId String, sectionId String, price Int64))') as items,
    JSONExtractString(payload, 'seatAssignment') as seat_assignment,
    JSONExtractBool(payload, 'firstInStage') as first_in_stage
from {{ source('bronze', 'brz_order_event') }}
where {{ event_filter() }}
