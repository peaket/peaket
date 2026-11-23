{{ config(order_by='(event_id, run_id, bot_class, basis)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- R2 동결(analytics §4.3, F-04-6): 마감 실행기가 onsale_run(R2 판)을 넘기면 다시 세지 않고 그 판의 행을 옮긴다(macros/close.sql)
{% set body %}
-- F6 봇 결과(analytics §5.2, R2): 회차 × 봇 범주 × 근거(실시간·허니팟·표본 검토·사후 라벨·대기 중 재평가). 그림자 판정은 넣지 않는다(실버가 뺐다).
-- 세션 수는 판정 대상 가명의 고유 수. 주문·좌석은 판정과 주문을 잇는 대기 기록이 아직 없어 0이다. 작은 칸 합치기(5 [가정])는 범주 이름을 '기타'로
with o as ({{ open_of() }}),
v as (
    select event_id, category, verdict_source, toUInt64(uniqExact(if(queue_entry_ref != '', queue_entry_ref, person_ref))) as sessions
    from {{ ref('slv_trust_label') }} where {{ event_filter() }} group by event_id, category, verdict_source
)
select v.event_id as event_id, {{ small_cell('v.category', 'v.sessions') }} as bot_class, v.verdict_source as basis,
       sum(v.sessions) as sessions, toUInt64(0) as orders, toUInt64(0) as seats,
       any(if(o.event_id = '', today(), o.open_day)) as open_date,
       {{ gold_cols() }}
from v left join o on o.event_id = v.event_id
group by event_id, bot_class, basis
{% endset %}
{{ onsale_or(body) }}
