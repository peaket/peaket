-- 브론즈 brz_trust_verdict → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'queueEntryId') as queue_entry_ref,
    JSONExtractString(payload, 'pid') as person_ref,
    JSONExtractString(payload, 'category') as category,
    JSONExtractString(payload, 'action') as action,
    JSONExtractString(payload, 'source') as verdict_source,
    JSONExtractBool(payload, 'shadow') as shadow,
    JSONExtractString(payload, 'reviewBatch') as review_batch
from {{ source('bronze', 'brz_trust_verdict') }}
where {{ event_filter() }}
