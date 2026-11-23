{{ config(materialized='view') }}
-- 판매 곡선(analytics §8.2 3, F-04-5): 현재 판의 등급 × 오픈 기준 분 누적 판매 좌석과 누적 판매율(÷ 등급 좌석 수). 같은 규모 기준선은 mtr_baseline_band
select c.event_id as event_id, c.tier_id as tier_id, c.open_minute as open_minute, c.sold as sold_seats, c.cum as cum_sold_seats,
       t.seat_count as seat_count, if(t.seat_count > 0, c.cum / t.seat_count, NULL) as cum_sale_rate
from (
    select event_id, tier_id, open_minute, sold,
           sum(sold) over (partition by event_id, tier_id order by open_minute rows between unbounded preceding and current row) as cum
    from (select event_id, tier_id, open_minute, sum(sold_seats) as sold from {{ ref('fct_sales_minute') }} where {{ current_run() }} and tier_id != '' group by event_id, tier_id, open_minute)
) as c
left join (select event_id, tier_id, seat_count from {{ ref('dim_tier') }} where {{ current_run() }}) as t on t.event_id = c.event_id and t.tier_id = c.tier_id
