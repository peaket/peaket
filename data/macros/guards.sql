{# 실행 변수 검사(analytics §4.1 'SQL 규칙'): 형식이 맞을 때만 SQL에 넣는다. 외부 입력으로 SQL 조각을 만들지 않는다 #}
{% macro uuid_var(name) -%}
  {%- set v = var(name) -%}
  {%- if v is none -%}{{ return(none) }}{%- endif -%}
  {%- if not modules.re.fullmatch('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', v | string) -%}
    {{ exceptions.raise_compiler_error('변수 ' ~ name ~ '는 UUID여야 한다') }}
  {%- endif -%}
  {{ return((v | string) | lower) }}
{%- endmacro %}

{% macro stage_var() -%}
  {%- set s = var('stage') | string -%}
  {%- if s not in ['R0', 'R1', 'R2', 'R3'] -%}{{ exceptions.raise_compiler_error('변수 stage는 R0~R3이어야 한다') }}{%- endif -%}
  {{ return(s) }}
{%- endmacro %}

{# 회차 하나만 다시 만들 때의 거르기(변수가 없으면 전체) #}
{% macro event_filter(col='event_id') -%}
  {%- set e = uuid_var('event_id') -%}
  {%- if e is not none -%} {{ col }} = '{{ e }}' {%- else -%} 1 = 1 {%- endif -%}
{%- endmacro %}

{# 골드 판 번호(실행마다 하나, ADR-0086 결정 8). 없으면 컴파일 오류 #}
{% macro run_id() -%}
  {%- set r = uuid_var('run_id') -%}
  {%- if r is none and execute -%}{{ exceptions.raise_compiler_error('골드를 만들려면 run_id(UUID)가 있어야 한다') }}{%- endif -%}
  '{{ r if r is not none else "00000000-0000-0000-0000-000000000000" }}'
{%- endmacro %}

{# 브론즈 payload에서 밀리초 시각 칸 → DateTime64(3)(없으면 NULL) #}
{% macro ms(field) -%}
  if(JSONHas(payload, '{{ field }}') AND JSONType(payload, '{{ field }}') != 'Null', fromUnixTimestamp64Milli(JSONExtractInt(payload, '{{ field }}')), NULL)
{%- endmacro %}
