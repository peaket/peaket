{{ config(order_by='(event_id, run_id, day, tier_id, pg)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- 날짜별 사실 잇기(analytics §4.3, F-04-6): carry_run이 있으면 carry_before 앞의 날은 앞 판에서 옮긴다(실버 90일 지움 뒤에도 R3 합이 맞게, macros/close.sql)
{% set body %}
-- F15 판매(날짜별, analytics §5.2·§4.3, A-T18): 날짜 × 회차 × 등급 × 결제사. 판매 좌석·주문·판매 금액(확정 주문 좌석 줄의 가격),
-- 되돌림(입금 되돌림 DEPOSIT_REVERSED의 좌석·금액), 반환 좌석(좌석 사건 RETURNED). R3 판매 대금 = 판매 금액 합 − 되돌림 금액 합
with o as ({{ open_of() }}),
pay as (
    select event_id, order_ref, any(pg) as pg from {{ ref('slv_payment_attempt') }}
    where {{ event_filter() }} and type = 'APPROVED' group by event_id, order_ref
),
items as (
    select c.event_id as event_id, toDate(c.occurred_at) as day, item.2 as tier_id, ifNull(p.pg, '') as pg, c.type as type, item.4 as price, c.order_ref as order_ref
    from {{ ref('slv_order') }} as c
    array join c.items as item
    left join pay as p on p.event_id = c.event_id and p.order_ref = c.order_ref
    where {{ event_filter('c.event_id') }} and c.type in ('CONFIRMED', 'DEPOSIT_REVERSED')
),
ret as (
    select event_id, toDate(occurred_at) as day, tier_id, '' as pg, 1 as seats
    from {{ ref('slv_seat_change') }} where {{ event_filter() }} and type = 'RETURNED'
),
u as (
    select event_id, day, tier_id, pg,
           toUInt64(countIf(type = 'CONFIRMED')) as sold_seats,
           toUInt64(uniqExactIf(order_ref, type = 'CONFIRMED')) as orders,
           toInt64(sumIf(price, type = 'CONFIRMED')) as sales_amount,
           toUInt64(countIf(type = 'DEPOSIT_REVERSED')) as reversed_seats,
           toInt64(sumIf(price, type = 'DEPOSIT_REVERSED')) as reversed_amount,
           toUInt64(0) as returned_seats
    from items group by event_id, day, tier_id, pg
    union all
    select event_id, day, tier_id, pg, 0, 0, 0, 0, 0, toUInt64(sum(seats)) from ret group by event_id, day, tier_id, pg
)
select u.event_id as event_id, u.day as day, u.tier_id as tier_id, u.pg as pg,
       sum(u.sold_seats) as sold_seats, sum(u.orders) as orders, sum(u.sales_amount) as sales_amount,
       sum(u.reversed_seats) as reversed_seats, sum(u.reversed_amount) as reversed_amount, sum(u.returned_seats) as returned_seats,
       any(if(o.event_id = '', u.day, o.open_day)) as open_date,
       {{ gold_cols() }}
from u left join o on o.event_id = u.event_id
group by event_id, day, tier_id, pg
{% endset %}
{{ with_carry(body, 'day') }}
