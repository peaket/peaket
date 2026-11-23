{{ config(order_by='(event_id, run_id, check_name)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- 데이터 품질 검사 결과(analytics §7, NFR-026, F-04-5): 이번 판의 회차 × 검사. status PASS·WARN·FAIL, affects는 FAIL일 때 판정을 보류할 지표 코드.
--   time_order: 시각 순서가 어긋난 구매 세션 수. 그 세션은 F3에서 격리하고(fct_funnel_cohort) 건수만 남긴다(WARN, 판정은 막지 않는다)
--   sold_le_target: 회차 판매 좌석 ≤ 판매 대상 좌석(불변식). 어기면 데이터 사고로 보고 판매 지표 판정을 보류한다
--   tier_reference: 판매 사실(F2)의 등급이 등급 차원(dim_tier)에 있다(참조 무결성. dbt relationships 시험도 같은 것을 본다)
--   external: 마감 실행기(F-04-6)가 넘긴 바깥 검사(커버리지·실시간 대비·정확성)의 실패 지표(변수 quality_failed)
{%- set external = var('quality_failed', []) %}
{%- for code in external %}{%- if not modules.re.fullmatch('[a-z0-9_]{1,64}', code | string) %}{{ exceptions.raise_compiler_error('quality_failed에는 지표 코드(소문자·숫자·밑줄)만 넣는다') }}{%- endif %}{%- endfor %}
with ev as (
    select event_id, seat_count, open_date from {{ ref('dim_event') }} where {{ this_run() }}
),
ord as (
    select event_id, toUInt64(countIf(not ({{ time_order_ok() }}))) as bad, toUInt64(count()) as n
    from {{ ref('slv_purchase_session') }} where {{ event_filter() }} group by event_id
),
sold as (
    select f.event_id as event_id, f.sold_seats as sold_seats, ifNull(e.seat_count, 0) as cap
    from (select event_id, sold_seats from {{ ref('fct_event_summary') }} where {{ this_run() }}) as f
    left join ev as e on e.event_id = f.event_id
),
tier_ref as (
    select s.event_id as event_id, toUInt64(countIf(t.tier_id = '')) as orphans
    from (select event_id, tier_id from {{ ref('fct_sales_minute') }} where {{ this_run() }} and tier_id != '' group by event_id, tier_id) as s
    left join (select event_id, tier_id from {{ ref('dim_tier') }} where {{ this_run() }}) as t on t.event_id = s.event_id and t.tier_id = s.tier_id
    group by event_id
),
checks as (
    select event_id, 'time_order' as check_name, if(bad > 0, 'WARN', 'PASS') as status, bad as failed_count, CAST([] AS Array(String)) as affects,
           concat('격리한 구매 세션 ', toString(bad), ' / ', toString(n)) as detail
    from ord
    union all
    select event_id, 'sold_le_target', if(cap > 0 and sold_seats > cap, 'FAIL', 'PASS'), toUInt64(if(cap > 0 and sold_seats > cap, sold_seats - cap, 0)),
           if(cap > 0 and sold_seats > cap, ['sold_seats', 'sales_amount', 'sale_rate_60m', 'sale_rate_eve', 'sold_out_minutes'], CAST([] AS Array(String))),
           concat('판매 좌석 ', toString(sold_seats), ' / 판매 대상 ', toString(cap))
    from sold
    union all
    select event_id, 'tier_reference', if(orphans > 0, 'FAIL', 'PASS'), orphans,
           if(orphans > 0, ['tier_sold_out_gap', 'sale_rate_60m'], CAST([] AS Array(String))),
           concat('차원에 없는 등급 ', toString(orphans))
    from tier_ref
    {%- if external | length > 0 %}
    union all
    select event_id, 'external', 'FAIL', toUInt64({{ external | length }}), [{% for c in external %}'{{ c }}'{{ ', ' if not loop.last }}{% endfor %}],
           '마감 실행기 바깥 검사 실패'
    from ev
    {%- endif %}
)
select c.event_id as event_id, c.check_name as check_name, c.status as status, c.failed_count as failed_count, c.affects as affects, c.detail as detail,
       if(ev.event_id = '', today(), ev.open_date) as open_date,
       {{ gold_cols() }}
from checks as c left join ev on ev.event_id = c.event_id
