{# 층 이름을 그대로 ClickHouse 데이터베이스로 쓴다(staging·silver·gold). dbt 기본은 '<대상>_<층>'을 만든다 #}
{% macro generate_schema_name(custom_schema_name, node) -%}
  {{ custom_schema_name if custom_schema_name is not none else target.schema }}
{%- endmacro %}
