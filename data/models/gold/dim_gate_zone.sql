{{ config(order_by='(event_id, gate_zone, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 게이트 구역 차원(analytics §5.3, 회차별): 입장 스캔에 나온 구역
select event_id, gate_zone, {{ gold_cols() }} from {{ ref('slv_ticket') }} where {{ event_filter() }} and gate_zone != '' group by event_id, gate_zone
