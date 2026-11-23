{# 지표 사전·규칙 판정 공통(analytics §6, F-04-5) #}

{# 이번 판(같은 dbt 실행이 만든 run_id)의 골드 행. 지표 값 표·규칙 판정이 쓴다 #}
{% macro this_run(alias='') -%}
  {%- set p = (alias ~ '.') if alias else '' -%}
  {{ p }}run_id = {{ run_id() }} and {{ event_filter(p ~ 'event_id') }}
{%- endmacro %}

{# 회차별 현재 판(gold.current_run, ADR-0086 결정 8). 지표 뷰(mtr_*)는 이 판의 행만 읽는다(analytics §4.1) #}
{% macro current_run(alias='') -%}
  {%- set p = (alias ~ '.') if alias else '' -%}
  ({{ p }}event_id, {{ p }}run_id) in (select event_id, argMax(run_id, switched_at) from gold.current_run group by event_id)
{%- endmacro %}

{# 지표 값 한 줄(metric_value의 칸 차례). 비율은 분자·분모를 함께 둔다(analytics §5.2 '비율과 분위수는 저장하지 않는다') #}
{% macro mrow(metric, value, num='NULL', den='NULL', sample='0', dim="''", ok='1') -%}
  '{{ metric }}' as metric, toString({{ dim }}) as dim, CAST({{ value }} AS Nullable(Float64)) as value,
  CAST({{ num }} AS Nullable(Float64)) as numerator, CAST({{ den }} AS Nullable(Float64)) as denominator,
  toUInt64({{ sample }}) as sample, toUInt8({{ ok }}) as source_ok
{%- endmacro %}

{% macro ratio(num, den) -%}
  if(({{ den }}) > 0, ({{ num }}) / ({{ den }}), NULL)
{%- endmacro %}

{# 95% Wilson 구간(analytics §6.4 '비율 규칙은 구간으로 판정한다', §9). z = 1.96, z² = 3.8416 #}
{% macro wilson(x, n, side) -%}
  if(({{ n }}) > 0,
     ((({{ x }}) / ({{ n }})) + 1.9208 / ({{ n }}) {{ '-' if side == 'low' else '+' }} 1.96 * sqrt(greatest((({{ x }}) / ({{ n }})) * (1 - ({{ x }}) / ({{ n }})), 0) / ({{ n }}) + 0.9604 / pow({{ n }}, 2)))
       / (1 + 3.8416 / ({{ n }})),
     NULL)
{%- endmacro %}

{# 등급별 매진 시각(지표 6, analytics §6.3): 등급 누적 판매 좌석(F2)이 등급 좌석 수(dim_tier)에 닿은 첫 오픈 기준 분.
   filter는 this_run() 또는 current_run()이다 #}
{% macro tier_sold_out(filter) -%}
  select t.event_id as event_id, t.tier_id as tier_id, t.tier_rank as tier_rank, t.seat_count as seat_count,
         max(ifNull(c.cum, 0)) as sold_seats,
         if(countIf(c.cum >= t.seat_count and t.seat_count > 0) = 0, CAST(NULL AS Nullable(Int32)), CAST(minIf(c.open_minute, c.cum >= t.seat_count and t.seat_count > 0) AS Nullable(Int32))) as sold_out_minute
  from (select event_id, tier_id, tier_rank, seat_count from {{ ref('dim_tier') }} where {{ filter }}) as t
  left join (
      select event_id, tier_id, open_minute,
             sum(sold) over (partition by event_id, tier_id order by open_minute rows between unbounded preceding and current row) as cum
      from (select event_id, tier_id, open_minute, sum(sold_seats) as sold from {{ ref('fct_sales_minute') }} where {{ filter }} and tier_id != '' group by event_id, tier_id, open_minute)
  ) as c on c.event_id = t.event_id and c.tier_id = t.tier_id
  group by event_id, tier_id, tier_rank, seat_count
{%- endmacro %}

{# 같은 규모 기준선(analytics §6.4, 기술 검토 낮음-044): 확정(R1~R3) 회차의 현재 판 값 가운데 같은 규모 등급·최근 2년·그 회차 제외.
   n < 3 없음, 3~9 범위(근거 약함, 중앙값은 비용 규칙의 배수 판정에만), 10 이상 중앙값과 사분위. subject는 (event_id, metric, dim, size_grade, open_date) 칸을 가진 질의다 #}
{% macro baseline_band(subject) -%}
  with s as ({{ subject }}),
  others as (
      select m.event_id as event_id, m.metric as metric, m.dim as dim, assumeNotNull(m.value) as value, d.size_grade as size_grade, d.open_date as open_date
      from {{ ref('metric_value') }} as m
      inner join (select event_id, run_id, size_grade, open_date from {{ ref('dim_event') }} where {{ current_run() }}) as d on d.event_id = m.event_id and d.run_id = m.run_id
      inner join (select event_id, run_id from {{ ref('fct_event_summary') }} where {{ current_run() }} and close_stage in ('R1', 'R2', 'R3')) as f on f.event_id = m.event_id and f.run_id = m.run_id
      where {{ current_run('m') }} and m.value is not null
  ),
  pairs as (
      select s.event_id as event_id, s.metric as metric, s.dim as dim, o.value as value, toUInt8(1) as hit
      from s inner join others as o on o.metric = s.metric and o.dim = s.dim and o.size_grade = s.size_grade
      where o.event_id != s.event_id and o.open_date <= s.open_date and o.open_date > s.open_date - 730
  )
  -- 왼쪽 결합에서 짝이 없는 줄은 hit = 0(ClickHouse 기본값)이라 If 집계로만 센다
  select s.event_id as event_id, s.metric as metric, s.dim as dim,
         toUInt64(countIf(p.hit = 1)) as baseline_n,
         multiIf(baseline_n < 3, 'NONE', baseline_n < 10, 'RANGE', 'IQR') as baseline_shape,
         multiIf(baseline_n < 3, '', baseline_n < 10, 'WEAK', 'NORMAL') as baseline_strength,
         if(baseline_n < 3, NULL, CAST(minIf(p.value, p.hit = 1) AS Nullable(Float64))) as baseline_min,
         if(baseline_n < 3, NULL, CAST(maxIf(p.value, p.hit = 1) AS Nullable(Float64))) as baseline_max,
         if(baseline_n < 3, NULL, CAST(quantileExactIf(0.5)(p.value, p.hit = 1) AS Nullable(Float64))) as baseline_median,
         if(baseline_n < 10, NULL, CAST(quantileExactIf(0.25)(p.value, p.hit = 1) AS Nullable(Float64))) as baseline_q1,
         if(baseline_n < 10, NULL, CAST(quantileExactIf(0.75)(p.value, p.hit = 1) AS Nullable(Float64))) as baseline_q3
  from s left join pairs as p on p.event_id = s.event_id and p.metric = s.metric and p.dim = s.dim
  group by event_id, metric, dim
{%- endmacro %}

{# 시각 순서(analytics §7): 입장 ≤ 첫 홀드 ≤ 결제 접수 ≤ 승인 ≤ 발권. 서로 다른 서비스 시각은 40ms까지 앞뒤가 바뀌어도 맞다.
   결제 접수·승인은 둘 다 purchase-svc 주문 사건이라 허용 폭을 두지 않는다(정본은 Kafka 위치로 견준다, 실버 구매 세션에 위치가 없어 시각으로 대신) #}
{% macro has_at(col) -%}({{ col }} is not null and toYear({{ col }}) >= 2000){%- endmacro %}
{% macro time_order_ok(alias='') -%}
  {%- set p = (alias ~ '.') if alias else '' -%}
  (not ({{ has_at(p ~ 'started_at') }} and {{ has_at(p ~ 'first_hold_at') }}) or {{ p }}first_hold_at >= {{ p }}started_at - toIntervalMillisecond(40))
  and (not ({{ has_at(p ~ 'first_hold_at') }} and {{ has_at(p ~ 'payment_accepted_at') }}) or {{ p }}payment_accepted_at >= {{ p }}first_hold_at - toIntervalMillisecond(40))
  and (not ({{ has_at(p ~ 'payment_accepted_at') }} and {{ has_at(p ~ 'approved_at') }}) or {{ p }}approved_at >= {{ p }}payment_accepted_at)
  and (not ({{ has_at(p ~ 'approved_at') }} and {{ has_at(p ~ 'confirmed_at') }}) or {{ p }}confirmed_at >= {{ p }}approved_at - toIntervalMillisecond(40))
{%- endmacro %}
