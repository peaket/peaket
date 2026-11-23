{{ config(order_by='(event_id, run_id, gate_zone, slot_10min)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F10 현장 입장(analytics §5.2): 회차 × 게이트 구역 × 10분. 입장, 거부(사유별 합), 오거부 후보(REJECT 뒤 같은 티켓 PASS), 이상 표시
with o as ({{ open_of() }})
select t.event_id as event_id, t.gate_zone as gate_zone, toStartOfInterval(ifNull(t.scanned_at, t.occurred_at), INTERVAL 10 MINUTE) as slot_10min,
       toUInt64(countIf(t.type = 'ENTRY_SCANNED' and t.scan_result = 'PASS')) as entries,
       toUInt64(countIf(t.type = 'ENTRY_SCANNED' and t.scan_result = 'REJECT')) as rejects,
       toUInt64(countIf(t.type = 'SCAN_FLAGGED')) as flags,
       any(if(o.event_id = '', toDate(t.occurred_at), o.open_day)) as open_date,
       {{ gold_cols() }}
from {{ ref('slv_ticket') }} as t left join o on o.event_id = t.event_id
where {{ event_filter('t.event_id') }} and t.type in ('ENTRY_SCANNED', 'SCAN_FLAGGED')
group by event_id, gate_zone, slot_10min
