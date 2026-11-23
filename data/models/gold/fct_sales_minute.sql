{{ config(order_by='(event_id, run_id, open_minute, tier_id, section_id, pg)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- R2 동결(analytics §4.3, F-04-6): 마감 실행기가 onsale_run(R2 판)을 넘기면 다시 세지 않고 그 판의 행을 옮긴다(macros/close.sql)
{% set body %}
-- F2 판매(analytics §5.2): 회차 × 등급 × 구역 × 결제사 × 오픈 기준 분. 판매 좌석·주문·판매 금액은 확정(CONFIRMED) 주문의 좌석 줄,
-- 결제사는 같은 주문 가명의 승인 결제, 다시 나온 좌석(만료·반환)은 좌석 사건(결제사 없음 '')이다(추천 적용 2026-11-23, F-04-4 계획)
with o as ({{ open_of() }}),
pay as (
    select event_id, order_ref, any(pg) as pg from {{ ref('slv_payment_attempt') }}
    where {{ event_filter() }} and type = 'APPROVED' group by event_id, order_ref
),
sold as (
    select c.event_id as event_id, c.occurred_at as at, item.2 as tier_id, item.3 as section_id, ifNull(p.pg, '') as pg,
           1 as seats, item.4 as amount, c.order_ref as order_ref
    from {{ ref('slv_order') }} as c
    array join c.items as item
    left join pay as p on p.event_id = c.event_id and p.order_ref = c.order_ref
    where {{ event_filter('c.event_id') }} and c.type = 'CONFIRMED'
),
released as (
    -- 홀드 만료율(지표 10, F-04-5)을 내려고 만료(EXPIRED)와 홀드 성공(HELD) 좌석 수를 따로 둔다. released_seats는 만료 + 반환 그대로다
    select event_id, occurred_at as at, tier_id, section_id, '' as pg, type
    from {{ ref('slv_seat_change') }} where {{ event_filter() }} and type in ('RETURNED', 'EXPIRED', 'HELD')
),
u as (
    select event_id, at, tier_id, section_id, pg, seats as sold_seats, amount as sales_amount, order_ref, 0 as released_seats, 0 as expired_seats, 0 as held_seats from sold
    union all
    select event_id, at, tier_id, section_id, pg, 0, 0, '', toUInt8(type != 'HELD'), toUInt8(type = 'EXPIRED'), toUInt8(type = 'HELD') from released
)
select u.event_id as event_id,
       {{ open_minute('u.at', or_event_time('o.ev_open_at', 'u.at')) }} as open_minute,
       u.tier_id as tier_id, u.section_id as section_id, u.pg as pg,
       toUInt64(sum(u.sold_seats)) as sold_seats,
       toUInt64(uniqExactIf(u.order_ref, u.order_ref != '')) as orders,
       toInt64(sum(u.sales_amount)) as sales_amount,
       toUInt64(sum(u.released_seats)) as released_seats,
       toUInt64(sum(u.expired_seats)) as expired_seats,
       toUInt64(sum(u.held_seats)) as held_seats,
       any(if(o.event_id = '', toDate(u.at), o.open_day)) as open_date,
       {{ gold_cols() }}
from u left join o on o.event_id = u.event_id
group by event_id, open_minute, tier_id, section_id, pg
{% endset %}
{{ onsale_or(body) }}
