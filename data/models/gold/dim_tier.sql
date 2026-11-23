{{ config(order_by='(event_id, tier_id, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 회차 차원 잇기(F-04-6): 브론즈 기준 자료(90일 보관)에 그 회차가 없으면 앞 판(carry_run)의 행을 옮긴다(macros/close.sql)
{% set body %}
-- 등급 차원(analytics §5.3, 회차별 처음 값): 가격·좌석 수·가격 순위(비싼 등급이 1)
select event_id, tier_id, price, seat_count,
       toUInt32(dense_rank() over (partition by event_id order by price desc)) as tier_rank, {{ gold_cols() }}
from (
    select event_id, tier_id, max(m.price) as price, toUInt64(sum(m.seat_count)) as seat_count
    from {{ ref('stg_ref_seat_map') }} as m where {{ event_filter('m.event_id') }} group by event_id, tier_id
)
{% endset %}
{{ with_carry(body, 'event') }}
