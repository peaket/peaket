-- eventKey마다 한 줄(가장 이른 Kafka 위치, analytics §5.5 'LIMIT 1 BY event_key'). 회차 단위 delete+insert(dbt_project.yml)
{{ config(order_by='(event_id, event_key)', partition_by='toYYYYMM(open_date)', ttl='toDateTime(source_loaded_at) + INTERVAL 90 DAY') }}
with src as (
    select * from {{ ref('stg_settlement_event') }}
    where {{ event_filter() }}
    order by kafka_partition, kafka_offset
    limit 1 by event_key
),
open_of as (
    select event_id, toDate(open_at) as open_day from {{ ref('stg_ref_event') }} where {{ event_filter() }}
)
select src.*, if(o.event_id = '', toDate(src.occurred_at), o.open_day) as open_date
from src
left join open_of as o on o.event_id = src.event_id
