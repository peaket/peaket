-- 브론즈 brz_ticket_event → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'ticketId') as ticket_ref,
    JSONExtractString(payload, 'orderId') as order_ref,
    JSONExtractString(payload, 'accountId') as account_ref,
    JSONExtractString(payload, 'type') as type,
    JSONExtractString(payload, 'scanResult') as scan_result,
    JSONExtractString(payload, 'reason') as reason,
    JSONExtractString(payload, 'gateZone') as gate_zone,
    JSONExtractString(payload, 'direction') as direction,
    {{ ms('scannedAt') }} as scanned_at
from {{ source('bronze', 'brz_ticket_event') }}
where {{ event_filter() }}
