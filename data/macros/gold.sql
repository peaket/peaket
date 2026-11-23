{# 골드 공통(analytics §5): 판 번호·만든 시각 칸, 회차 오픈 시각, 오픈 기준 분(T-10~T+60은 1분, 그 뒤는 10분 묶음) #}
{% macro gold_cols() -%}
  {{ run_id() }} as run_id, now64(3) as built_at
{%- endmacro %}

{# 회차마다 오픈 시각과 오픈 날(기준 자료가 없으면 사건에서 가장 이른 날) #}
{% macro open_of() -%}
  -- 별칭을 열 이름과 다르게 둔다(같으면 뒤 식의 open_at이 집계 별칭으로 읽혀 184 오류)
  select event_id, any(open_at) as ev_open_at, toDate(any(open_at)) as open_day
  from {{ ref('stg_ref_event') }} where {{ event_filter() }} group by event_id
{%- endmacro %}

{% macro open_minute(ts, open_at) -%}
  multiIf(
    dateDiff('minute', {{ open_at }}, {{ ts }}) <= 60, toInt32(dateDiff('minute', {{ open_at }}, {{ ts }})),
    toInt32(60 + intDiv(dateDiff('minute', {{ open_at }}, {{ ts }}) - 60, 10) * 10)
  )
{%- endmacro %}

{# 기준 자료가 없는 회차(기본값 1970)면 사건 시각으로 대신한다 #}
{% macro or_event_time(open_col, ts) -%}
  if(toYear({{ open_col }}) < 2000, {{ ts }}, {{ open_col }})
{%- endmacro %}

{# 작은 칸 합치기(analytics §5.2 끝 줄·§11): 세션(건) 수가 기준 미만이면 '기타' #}
{% macro small_cell(label, n) -%}
  if({{ n }} < {{ var('small_cell_min') }}, '기타', {{ label }})
{%- endmacro %}
