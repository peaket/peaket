{{ config(order_by='(event_id, run_id)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F11 회차 요약(analytics §5.2, 회차 1행). 매진 시각은 판매 상태가 처음 SOLD_OUT이 된 때(지표 5), 매진 풀림 횟수, 판매 좌석(좌석마다 마지막 판매 상태가
-- SOLD, streaming §4.3과 같은 규칙), 판매 금액(승인 − 입금 되돌림, 지표 26), 발권. SLO·불변식·비용·수수료·결제사 한도 칸은 원천 파일(brz_slo_snapshot·brz_cost)이
-- 아직 없어 NULL이다(F-04-6 몫). 마감 단계는 실행 변수 stage
with o as ({{ open_of() }}),
sale as (
    select event_id,
           minIf(occurred_at, status = 'SOLD_OUT') as sold_out_at,
           countIf(previous_status = 'SOLD_OUT' and status != 'SOLD_OUT') as sold_out_releases
    from {{ ref('slv_event_sale') }} where {{ event_filter() }} group by event_id
),
seat as (
    select event_id, toUInt64(countIf(last_type = 'SOLD')) as sold_seats from (
        select event_id, seat_id, argMax(type, (kafka_partition, kafka_offset)) as last_type
        from {{ ref('slv_seat_change') }} where {{ event_filter() }} and type in ('PENDING', 'SOLD', 'RETURNED') group by event_id, seat_id
    ) group by event_id
),
pay as (
    select event_id, toInt64(sumIf(amount, type = 'APPROVED') - sumIf(amount, type = 'DEPOSIT_REVERSED')) as sales_amount
    from {{ ref('slv_payment_attempt') }} where {{ event_filter() }} group by event_id
),
tk as (
    select event_id, toInt64(countIf(type = 'ISSUED')) - toInt64(countIf(type = 'VOIDED')) as tickets_issued
    from {{ ref('slv_ticket') }} where {{ event_filter() }} group by event_id
),
events as (
    select event_id from seat union distinct select event_id from pay union distinct select event_id from sale union distinct select event_id from o
)
select e.event_id as event_id,
       if(toYear(sale.sold_out_at) < 2000, NULL, sale.sold_out_at) as sold_out_at,
       ifNull(sale.sold_out_releases, 0) as sold_out_releases,
       ifNull(seat.sold_seats, 0) as sold_seats,
       ifNull(pay.sales_amount, 0) as sales_amount,
       ifNull(tk.tickets_issued, 0) as tickets_issued,
       CAST(NULL AS Nullable(UInt64)) as slo_good, CAST(NULL AS Nullable(UInt64)) as slo_total,
       CAST(NULL AS Nullable(UInt64)) as invariant_violations, CAST(NULL AS Nullable(Int64)) as cost_amount, CAST(NULL AS Nullable(Int64)) as fee_amount,
       '{{ stage_var() }}' as close_stage,
       if(o.event_id = '', today(), o.open_day) as open_date,
       {{ gold_cols() }}
from events as e
left join sale on sale.event_id = e.event_id
left join seat on seat.event_id = e.event_id
left join pay on pay.event_id = e.event_id
left join tk on tk.event_id = e.event_id
left join o on o.event_id = e.event_id
