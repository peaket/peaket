-- 브론즈 brz_hold_attempt → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'purchaseSessionId') as purchase_session_ref,
    JSONExtractString(payload, 'mode') as mode,
    JSONExtractString(payload, 'tierId') as tier_id,
    JSONExtractString(payload, 'sectionId') as section_id,
    JSONExtract(payload, 'seatIds', 'Array(String)') as seat_ids,
    JSONExtractString(payload, 'result') as result,
    JSONExtractString(payload, 'autoResult') as auto_result,
    {{ ms('heldAt') }} as held_at,
    JSONExtractBool(payload, 'firstHeldInSession') as first_held_in_session,
    JSONExtractInt(payload, 'retryNo') as retry_no,
    JSONExtractInt(payload, 'latencyMs') as latency_ms
from {{ source('bronze', 'brz_hold_attempt') }}
where {{ event_filter() }}
