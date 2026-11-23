{{ config(materialized='view') }}
-- 파트너 판매 요약(analytics §8.4, F-04-7): R3 현재 판의 회차 한 줄. 판매량·매진 시각·등급별 판매·매출·환불·판매 곡선.
-- 봇 범주·가명·규칙 수치·다른 테넌트 비교는 넣지 않는다(POL-037·040). 테넌트 필터는 API(ops-svc)가 건다.
-- 등급별 판매·매출은 F15(날짜별 판매)에서, 매진 시각은 F11·mtr_tier_sold_out에서, 곡선은 F2(온세일)에서 온다.
-- 곡선 칸은 10분 묶음이고, 5건 [가정] 미만 칸은 구역 안에서 합친다(merged=1).
with cur as (
    select f.event_id as event_id, f.sold_seats as sold_seats, f.sold_out_at as sold_out_at
    from {{ ref('fct_event_summary') }} as f
    inner join (select event_id from {{ ref('dim_event') }} where {{ current_run() }}) as e on e.event_id = f.event_id
    where {{ current_run('f') }} and f.close_stage = 'R3'
),
tier as (
    select event_id, tier_id,
           toUInt64(sum(sold_seats)) as sold_seats,
           toUInt64(sum(returned_seats)) as refunded_seats,
           toInt64(sum(sales_amount)) as sales_amount
    from {{ ref('fct_sales_daily') }} where {{ current_run() }} group by event_id, tier_id
),
tier_time as (
    select t.event_id as event_id, t.tier_id as tier_id,
           if(t.sold_out_minute is null, NULL, e.open_at + toIntervalMinute(assumeNotNull(t.sold_out_minute))) as sold_out_at
    from {{ ref('mtr_tier_sold_out') }} as t
    inner join (select event_id, open_at from {{ ref('dim_event') }} where {{ current_run() }}) as e on e.event_id = t.event_id
),
tier_agg as (
    select t.event_id as event_id,
           groupArray(tuple(t.tier_id, t.sold_seats, t.refunded_seats, t.sales_amount, tt.sold_out_at)) as by_tier
    from tier as t left join tier_time as tt on tt.event_id = t.event_id and tt.tier_id = t.tier_id
    group by t.event_id
),
curve_cells as (
    select event_id, section_id,
           toInt32(intDiv(open_minute, 10) * 10) as minute_from,
           toInt32(intDiv(open_minute, 10) * 10 + 9) as minute_to,
           toUInt64(sum(f.sold_seats)) as seats
    from {{ ref('fct_sales_minute') }} as f where {{ current_run() }} and section_id != ''
    group by event_id, section_id, minute_from, minute_to
),
curve_positive as (
    select event_id, section_id, minute_from, minute_to, seats as sold_seats from curve_cells where curve_cells.seats > 0
),
curve as (
    -- 판매 5건 [가정] 미만 칸은 구역 안에서 하나로 합친다(merged=1). 큰 칸은 그대로 둔다(analytics §8.4)
    select event_id, section_id, minute_from, minute_to, sold_seats, toUInt8(0) as merged
    from curve_positive where curve_positive.sold_seats >= {{ var('small_cell_min') }}
    union all
    select event_id, section_id, toInt32(min(minute_from)) as minute_from, toInt32(max(minute_to)) as minute_to,
           toUInt64(sum(curve_positive.sold_seats)) as sold_seats, toUInt8(1) as merged
    from curve_positive where curve_positive.sold_seats < {{ var('small_cell_min') }} group by event_id, section_id
),
curve_agg as (
    select event_id, groupArray(tuple(section_id, minute_from, minute_to, sold_seats, merged)) as sales_curve
    from curve group by event_id
),
ref as (
    select event_id, toUInt64(sum(refunds)) as refunds, toInt64(sum(refund_amount)) as refund_amount
    from {{ ref('fct_refund_daily') }} where {{ current_run() }} group by event_id
)
select c.event_id as event_id, c.sold_seats as sold_seats, c.sold_out_at as sold_out_at,
       ta.by_tier as by_tier,
       ca.sales_curve as sales_curve,
       tuple(ifNull(r.refunds, 0), ifNull(r.refund_amount, 0)) as refunds,
       CAST([] AS Array(String)) as recommendations
from cur as c
left join tier_agg as ta on ta.event_id = c.event_id
left join curve_agg as ca on ca.event_id = c.event_id
left join ref as r on r.event_id = c.event_id
