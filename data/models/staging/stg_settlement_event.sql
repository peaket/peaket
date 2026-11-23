-- 브론즈 brz_settlement_event → 칸(analytics §4.1 stg_). 가명 칸은 이미 회차 가명이다(F-04-3). 시각은 밀리초 → DateTime64(3)
select
    event_id,
    event_key,
    occurred_at,
    loaded_at as source_loaded_at,
    key_version,
    kafka_topic, kafka_partition, kafka_offset,
    JSONExtractString(payload, 'promoterId') as promoter_id,
    JSONExtractString(payload, 'statementId') as statement_id,
    JSONExtractString(payload, 'kind') as kind,
    JSONExtractString(payload, 'pg') as pg,
    JSONExtractString(payload, 'type') as type,
    JSONExtractInt(payload, 'salesAmount') as sales_amount,
    JSONExtractInt(payload, 'refundAmount') as refund_amount,
    JSONExtractInt(payload, 'feeAmount') as fee_amount,
    JSONExtractInt(payload, 'revision') as revision
from {{ source('bronze', 'brz_settlement_event') }}
where {{ event_filter() }}
