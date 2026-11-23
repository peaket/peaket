{{ config(order_by='(venue_id, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 공연장 차원(analytics §5.3)
select venue_id, any(venue_name) as venue_name, {{ gold_cols() }} from {{ ref('stg_ref_event') }} where {{ event_filter() }} group by venue_id
