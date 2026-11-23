{{ config(materialized='table', order_by='day') }}
-- 날짜 차원(analytics §5.3, 고정): 2025-01-01부터 2028-12-31까지. 영업일은 주말과 공휴일(마감 실행기가 넘기는 holidays, payment·settlement와 같은 원천)을 뺀 값이다
{%- set holidays = var('holidays', []) %}
{%- for h in holidays %}
  {%- if not modules.re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}', h | string) %}
    {{ exceptions.raise_compiler_error('holidays에는 YYYY-MM-DD 날짜만 넣는다') }}
  {%- endif %}
{%- endfor %}
select toDate('2025-01-01') + number as day, toDayOfWeek(day) as weekday,
       toUInt8(has(CAST([{% for h in holidays %}'{{ h }}'{{ ', ' if not loop.last }}{% endfor %}] AS Array(String)), toString(day))) as holiday,
       weekday <= 5 and not holiday as business_day
from numbers(1461)
