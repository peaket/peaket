{{ config(order_by='(event_id, section_id, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 회차 차원 잇기(F-04-6): 브론즈 기준 자료(90일 보관)에 그 회차가 없으면 앞 판(carry_run)의 행을 옮긴다(macros/close.sql)
{% set body %}
-- 구역 차원(analytics §5.3, 회차별 스냅샷): 마지막 배치 판의 구역 이름·좌석 수
select event_id, section_id, any(section_name) as section_name, toUInt64(sum(seat_count)) as seat_count, {{ gold_cols() }}
from {{ ref('stg_ref_seat_map') }} where {{ event_filter() }} group by event_id, section_id
{% endset %}
{{ with_carry(body, 'event') }}
