{# 골드 '회차별 현재 판' 바꾸기(ADR-0086 결정 8, analytics §4.1·§5.5). 시험을 모두 통과한 뒤 마감 실행기(F-04-6)가 부른다:
   dbt run-operation swap_current_run --args '{event_id: ..., run_id: ...}' #}
{% macro swap_current_run(event_id, run_id) %}
  {%- set guard = modules.re.compile('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}') -%}
  {%- if not guard.fullmatch(event_id | string) or not guard.fullmatch(run_id | string) -%}{{ exceptions.raise_compiler_error('event_id·run_id는 UUID여야 한다') }}{%- endif -%}
  {% do run_query(ensure_current_run()) %}
  {% do run_query("INSERT INTO gold.current_run (event_id, run_id, switched_at) VALUES ('" ~ (event_id | lower) ~ "', '" ~ (run_id | lower) ~ "', now64(3))") %}
{% endmacro %}

{# 현재 판 표 만들기. 지표 뷰(mtr_*)가 이 표를 읽으므로 dbt 실행 앞(on-run-start)에도 만든다(F-04-5) #}
{% macro ensure_current_run() -%}
  CREATE TABLE IF NOT EXISTS gold.current_run (event_id String, run_id String, switched_at DateTime64(3)) ENGINE = ReplacingMergeTree(switched_at) ORDER BY event_id
{%- endmacro %}
