-- 브론즈 brz_event_sale → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'status') as status,
    JSONExtractString(payload, 'previousStatus') as previous_status,
    JSONExtractInt(payload, 'available') as available,
    JSONExtractInt(payload, 'held') as held,
    JSONExtractInt(payload, 'paying') as paying,
    JSONExtract(payload, 'soldOutTiers', 'Array(String)') as sold_out_tiers,
    JSONExtractInt(payload, 'version') as version
from {{ source('bronze', 'brz_event_sale') }}
where {{ event_filter() }}
