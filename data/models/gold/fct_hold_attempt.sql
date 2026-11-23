{{ config(order_by='(event_id, run_id, open_minute, tier_id, section_id, assignment, result, retry_no)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- R2 동결(analytics §4.3, F-04-6): 마감 실행기가 onsale_run(R2 판)을 넘기면 다시 세지 않고 그 판의 행을 옮긴다(macros/close.sql)
{% set body %}
-- F4 홀드 시도(analytics §5.2): 회차 × 등급 × 구역 × 분 × 배정 방식 × 결과 × 재시도 순번. 시도 수, 세션 첫 시도 수, 지연 버킷(ms, 100·250·500·1000·2000 넘음)
with o as ({{ open_of() }})
select h.event_id as event_id,
       {{ open_minute('h.occurred_at', or_event_time('o.ev_open_at', 'h.occurred_at')) }} as open_minute,
       h.tier_id as tier_id, h.section_id as section_id, h.mode as assignment, h.result as result, toUInt32(least(h.retry_no, 10)) as retry_no,
       toUInt64(count()) as attempts,
       toUInt64(countIf(h.retry_no = 0)) as first_attempts,
       toUInt64(countIf(h.latency_ms <= 100)) as latency_le_100,
       toUInt64(countIf(h.latency_ms <= 250)) as latency_le_250,
       toUInt64(countIf(h.latency_ms <= 500)) as latency_le_500,
       toUInt64(countIf(h.latency_ms <= 1000)) as latency_le_1000,
       toUInt64(countIf(h.latency_ms <= 2000)) as latency_le_2000,
       any(if(o.event_id = '', toDate(h.occurred_at), o.open_day)) as open_date,
       {{ gold_cols() }}
from {{ ref('slv_hold_attempt') }} as h left join o on o.event_id = h.event_id
where {{ event_filter('h.event_id') }}
group by event_id, open_minute, tier_id, section_id, assignment, result, retry_no
{% endset %}
{{ onsale_or(body) }}
