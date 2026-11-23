-- 브론즈 brz_purchase_session → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    record,
    JSONExtractString(payload, 'purchaseSessionId') as purchase_session_ref,
    JSONExtractString(payload, 'admissionJti') as admission_ref,
    {{ ms('startedAt') }} as started_at,
    {{ ms('maxStayUntil') }} as max_stay_until,
    {{ ms('endedAt') }} as ended_at,
    JSONExtractString(payload, 'reason') as end_reason
from {{ source('bronze', 'brz_purchase_session') }}
where {{ event_filter() }}
