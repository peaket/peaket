-- 브론즈 brz_seat_event → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'seatId') as seat_id,
    JSONExtractString(payload, 'tierId') as tier_id,
    JSONExtractString(payload, 'sectionId') as section_id,
    JSONExtractString(payload, 'type') as type,
    JSONExtractString(payload, 'holdId') as hold_ref,
    JSONExtractString(payload, 'purchaseSessionId') as purchase_session_ref,
    JSONExtractString(payload, 'accountId') as account_ref,
    {{ ms('expiresAt') }} as expires_at
from {{ source('bronze', 'brz_seat_event') }}
where {{ event_filter() }}
