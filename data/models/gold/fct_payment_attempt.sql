{{ config(order_by='(event_id, run_id, open_minute, pg, pay_method, result, failure_category)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F5 결제 시도(analytics §5.2): 회차 × 결제사 × 결제 수단 범주 × 결과 × 실패 범주 × 분. 시도 수, 금액, 응답 시간 버킷(ms)
with o as ({{ open_of() }})
select p.event_id as event_id,
       {{ open_minute('p.occurred_at', or_event_time('o.ev_open_at', 'p.occurred_at')) }} as open_minute,
       p.pg as pg, p.pay_method_category as pay_method, p.type as result, p.failure_category as failure_category,
       toUInt64(count()) as attempts, toInt64(sum(p.amount)) as amount,
       toUInt64(countIf(p.latency_ms <= 500)) as latency_le_500,
       toUInt64(countIf(p.latency_ms <= 1000)) as latency_le_1000,
       toUInt64(countIf(p.latency_ms <= 2000)) as latency_le_2000,
       toUInt64(countIf(p.latency_ms <= 5000)) as latency_le_5000,
       any(if(o.event_id = '', toDate(p.occurred_at), o.open_day)) as open_date,
       {{ gold_cols() }}
from {{ ref('slv_payment_attempt') }} as p left join o on o.event_id = p.event_id
where {{ event_filter('p.event_id') }} and p.type in ('APPROVED', 'FAILED', 'UNKNOWN', 'AWAITING_DEPOSIT')
group by event_id, open_minute, pg, pay_method, result, failure_category
