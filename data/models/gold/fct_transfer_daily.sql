{{ config(order_by='(event_id, run_id, day, state)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F9 양도(날짜별, analytics §5.2): 날짜 × 회차 × 상태 × 공연까지 남은 일수 구간. 읽는 콘솔 화면(양도)은 동결이지만 리포트 R3가 읽을 수 있게 모델은 둔다
with o as ({{ open_of() }}),
r as (select event_id, any(starts_at) as starts_at from {{ ref('stg_ref_event') }} where {{ event_filter() }} group by event_id)
select t.event_id as event_id, toDate(t.occurred_at) as day, t.type as state,
       multiIf(toYear(r.starts_at) < 2000, 'unknown', dateDiff('day', t.occurred_at, r.starts_at) <= 1, '<=1d', dateDiff('day', t.occurred_at, r.starts_at) <= 7, '2-7d', '>7d') as days_to_show,
       toUInt64(count()) as transfers,
       any(if(o.event_id = '', toDate(t.occurred_at), o.open_day)) as open_date,
       {{ gold_cols() }}
from {{ ref('slv_ticket') }} as t
left join r on r.event_id = t.event_id
left join o on o.event_id = t.event_id
where {{ event_filter('t.event_id') }} and t.type in ('TRANSFER_OFFERED', 'TRANSFER_ACCEPTED', 'TRANSFER_REJECTED', 'TRANSFER_WITHDRAWN', 'TRANSFER_EXPIRED', 'TRANSFERRED')
group by event_id, day, state, days_to_show
