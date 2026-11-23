{{ config(order_by='(event_id, run_id)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- 회차 차원 잇기(F-04-6): 브론즈 기준 자료(90일 보관)에 그 회차가 없으면 앞 판(carry_run)의 행을 옮긴다(macros/close.sql)
{% set body %}
-- 회차 차원(analytics §5.3): 오픈 30분 전 스냅샷(유형 0). 기준 자료(brz_ref_event, F-04-6이 싣는다)가 있는 회차만
select event_id, production_id, production_name, genre, venue_id, venue_name, starts_at, open_at, sale_end_at, seat_count, sale_policy,
       promoter_name, size_grade, toDate(open_at) as open_date, {{ gold_cols() }}
from {{ ref('stg_ref_event') }} where {{ event_filter() }}
{% endset %}
{{ with_carry(body, 'event') }}
