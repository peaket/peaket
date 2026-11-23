{{ config(order_by='(event_id, run_id, day, tier_id, route)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- 날짜별 사실 잇기(analytics §4.3, F-04-6): carry_run이 있으면 carry_before 앞의 날은 앞 판에서 옮긴다(실버 90일 지움 뒤에도 R3 합이 맞게, macros/close.sql)
{% set body %}
-- F8 환불(날짜별, analytics §5.2): 날짜 × 회차 × 등급 × 경로(셀프·회차 취소·예외). 금액은 refundAmount. 경로: 고객 취소 REFUNDED·PARTIALLY_REFUNDED는 셀프,
-- 회차 취소 확정 EVENT_CANCELLATION_CONFIRMED는 회차 취소, COMPENSATION_PAID는 예외(추천 적용 2026-11-23, F-04-4 계획)
with o as ({{ open_of() }}),
r as (
    select c.event_id as event_id, toDate(c.occurred_at) as day,
           if(length(c.items) > 0, c.items[1].2, '') as tier_id,
           multiIf(c.type in ('REFUNDED', 'PARTIALLY_REFUNDED'), 'SELF', c.type = 'EVENT_CANCELLATION_CONFIRMED', 'EVENT_CANCELLATION', 'EXCEPTION') as route,
           c.refund_amount as amount
    from {{ ref('slv_order') }} as c
    where {{ event_filter('c.event_id') }} and c.type in ('REFUNDED', 'PARTIALLY_REFUNDED', 'EVENT_CANCELLATION_CONFIRMED', 'COMPENSATION_PAID')
)
select r.event_id as event_id, r.day as day, r.tier_id as tier_id, r.route as route,
       toUInt64(count()) as refunds, toInt64(sum(r.amount)) as refund_amount,
       any(if(o.event_id = '', r.day, o.open_day)) as open_date,
       {{ gold_cols() }}
from r left join o on o.event_id = r.event_id
group by event_id, day, tier_id, route
{% endset %}
{{ with_carry(body, 'day') }}
