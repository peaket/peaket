{{ config(order_by='(event_id, tier_id, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 등급 차원(analytics §5.3, 회차별 처음 값): 가격·좌석 수·가격 순위(비싼 등급이 1)
select event_id, tier_id, price, seat_count,
       toUInt32(dense_rank() over (partition by event_id order by price desc)) as tier_rank, {{ gold_cols() }}
from (
    select event_id, tier_id, max(m.price) as price, toUInt64(sum(m.seat_count)) as seat_count
    from {{ ref('stg_ref_seat_map') }} as m where {{ event_filter('m.event_id') }} group by event_id, tier_id
)
