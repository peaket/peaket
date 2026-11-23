{{ config(order_by='(promoter_id, run_id)', ttl='toDate(built_at) + INTERVAL 2 YEAR') }}
-- 파트너 차원(analytics §5.3, 유형 1 덮어쓰기). 테넌트 ID는 정산 사건의 promoterId, 상호는 회차 기준 자료. 개인정보는 넣지 않는다
select promoter_id, any(promoter_name) as promoter_name, {{ gold_cols() }} from (
    select s.promoter_id as promoter_id, ifNull(r.promoter_name, '') as promoter_name
    from {{ ref('slv_settlement') }} as s left join {{ ref('stg_ref_event') }} as r on r.event_id = s.event_id
    where {{ event_filter('s.event_id') }} or s.event_id = ''
) group by promoter_id
