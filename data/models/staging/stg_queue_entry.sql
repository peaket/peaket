-- 브론즈 brz_queue_entry → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'queueEntryId') as queue_entry_ref,
    JSONExtractString(payload, 'pid') as person_ref,
    JSONExtractInt(payload, 'number') as number,
    JSONExtractString(payload, 'entryMode') as entry_mode,
    {{ ms('enteredAt') }} as entered_at,
    JSONExtractInt(payload, 'firstEtaSec') as first_eta_sec,
    {{ ms('turnAt') }} as turn_at,
    {{ ms('admittedAt') }} as admitted_at,
    JSONExtractString(payload, 'admissionJti') as admission_ref,
    {{ ms('removedAt') }} as removed_at,
    JSONExtractString(payload, 'removeReason') as remove_reason,
    JSONExtractString(payload, 'verifyRoute') as verify_route
from {{ source('bronze', 'brz_queue_entry') }}
where {{ event_filter() }}
