{# 마감 실행기(close-runner, F-04-6)가 넘기는 판 잇기 변수(analytics §4.3 '재실행·동결·늦은 이벤트').
   원시(브론즈·실버)는 적재 뒤 90일에 지워지므로, 판매 기간이 긴 회차는 앞 판의 골드 행을 옮겨 숫자를 지킨다.
   - onsale_run: R2 판 ID. 있으면 온세일 사실(F1~F7)을 다시 세지 않고 그 판의 행을 이번 판으로 옮긴다(R2 동결)
   - carry_run·carry_before: 앞 현재 판 ID와 날짜(YYYY-MM-DD). 날짜별 사실(F15·F8)은 carry_before보다 앞선 날의 행을 앞 판에서 옮기고,
     회차 차원(dim_event 등)은 원천(브론즈 기준 자료)에 그 회차가 없을 때만 앞 판에서 옮긴다 #}

{% macro date_var(name) -%}
  {%- set v = var(name) -%}
  {%- if v is none -%}{{ return(none) }}{%- endif -%}
  {%- if not modules.re.fullmatch('[0-9]{4}-[0-9]{2}-[0-9]{2}', v | string) -%}
    {{ exceptions.raise_compiler_error('변수 ' ~ name ~ '는 YYYY-MM-DD여야 한다') }}
  {%- endif -%}
  {{ return(v | string) }}
{%- endmacro %}

{# 온세일 사실: R2 판이 있으면 그 판의 행을 옮기고, 없으면 원래 계산.
   원천 열 이름(run_id)과 새 별칭(run_id)이 겹치면 ClickHouse가 WHERE의 run_id를 새 별칭으로 읽어 0행이 된다.
   그래서 원천을 src로 묶고 자격 이름(src.run_id)으로 거른다 #}
{% macro onsale_or(body) -%}
  {%- set r = uuid_var('onsale_run') -%}
  {%- if r is none -%}
{{ body }}
  {%- else -%}
select * except (run_id, built_at), {{ gold_cols() }} from {{ this }} as src where src.run_id = '{{ r }}' and {{ event_filter('src.event_id') }}
  {%- endif -%}
{%- endmacro %}

{# 앞 판 잇기. mode 'day'는 날짜별 사실(칸 day), 'event'는 회차 차원. 원천을 src로 묶어 run_id 별칭이 WHERE를 가리지 않게 한다 #}
{% macro with_carry(body, mode) -%}
  {%- set carry = uuid_var('carry_run') -%}
  {%- if carry is none -%}
{{ body }}
  {%- elif mode == 'day' -%}
    {%- set before = date_var('carry_before') -%}
    {%- if before is none -%}{{ exceptions.raise_compiler_error('carry_run에는 carry_before가 함께 있어야 한다') }}{%- endif -%}
select * from ({{ body }}) where day >= toDate('{{ before }}')
union all
select * except (run_id, built_at), {{ gold_cols() }} from {{ this }} as src where src.run_id = '{{ carry }}' and {{ event_filter('src.event_id') }} and src.day < toDate('{{ before }}')
  {%- else -%}
select * from ({{ body }})
union all
select * except (run_id, built_at), {{ gold_cols() }} from {{ this }} as src where src.run_id = '{{ carry }}' and {{ event_filter('src.event_id') }} and src.event_id not in (select event_id from ({{ body }}))
  {%- endif -%}
{%- endmacro %}
