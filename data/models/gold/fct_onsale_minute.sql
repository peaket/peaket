{{ config(order_by='(event_id, run_id, open_minute)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F1 온세일 분 스냅샷(analytics §5.2): 회차 × 오픈 기준 분. 진입·입장·차례 도달·차례 뒤 미입장(대기 기록), 봇 차단·추가 검증(판정 기록),
-- 주문 생성·결제 접수·승인·실패·발권(주문·결제·티켓). 대기 기록(QueueEntryRecord)은 queue-svc가 아직 내지 않아 그 칸은 0이다(F-04-7 범위 때)
with o as ({{ open_of() }}),
q as (
    select event_id, entered_at as at, 'entered' as k from {{ ref('slv_queue_entry') }} where {{ event_filter() }}
    union all select event_id, admitted_at, 'admitted' from {{ ref('slv_queue_entry') }} where {{ event_filter() }} and toYear(admitted_at) >= 2000
    union all select event_id, turn_at, 'turn' from {{ ref('slv_queue_entry') }} where {{ event_filter() }} and toYear(turn_at) >= 2000
    union all select event_id, removed_at, 'no_confirm' from {{ ref('slv_queue_entry') }} where {{ event_filter() }} and remove_reason = 'NO_CONFIRM'
    union all select event_id, occurred_at, if(category = 'BLOCKED', 'bot_blocked', 'challenged') from {{ ref('slv_trust_label') }} where {{ event_filter() }} and category in ('BLOCKED', 'CHALLENGED')
    union all select event_id, occurred_at, if(category = 'CHALLENGE_PASSED', 'challenge_passed', 'challenge_failed') from {{ ref('slv_trust_label') }} where {{ event_filter() }} and category in ('CHALLENGE_PASSED', 'CHALLENGE_FAILED')
    union all select event_id, occurred_at, lower(type) from {{ ref('slv_order') }} where {{ event_filter() }} and type in ('CREATED', 'ACCEPTED', 'APPROVED', 'FAILED')
    union all select event_id, occurred_at, 'issued' from {{ ref('slv_ticket') }} where {{ event_filter() }} and type = 'ISSUED'
)
select q.event_id as event_id,
       -- 정렬 키 칸은 Nullable이면 안 된다: 시각이 없는 줄은 아래 where로 빼고 assumeNotNull로 형을 푼다
       {{ open_minute('assumeNotNull(q.at)', or_event_time('o.ev_open_at', 'assumeNotNull(q.at)')) }} as open_minute,
       toUInt64(countIf(k = 'entered')) as entries, toUInt64(countIf(k = 'admitted')) as admissions,
       toUInt64(countIf(k = 'turn')) as turns, toUInt64(countIf(k = 'no_confirm')) as no_confirms,
       toUInt64(countIf(k = 'bot_blocked')) as bot_blocked, toUInt64(countIf(k = 'challenged')) as challenged,
       toUInt64(countIf(k = 'challenge_passed')) as challenge_passed, toUInt64(countIf(k = 'challenge_failed')) as challenge_failed,
       toUInt64(countIf(k = 'created')) as orders_created, toUInt64(countIf(k = 'accepted')) as payments_accepted,
       toUInt64(countIf(k = 'approved')) as payments_approved, toUInt64(countIf(k = 'failed')) as payments_failed,
       toUInt64(countIf(k = 'issued')) as tickets_issued,
       -- TTL 기준 칸은 Nullable이면 안 된다(대기 기록 시각은 Nullable)
       any(if(o.event_id = '', toDate(ifNull(q.at, now64(3))), o.open_day)) as open_date,
       {{ gold_cols() }}
from q left join o on o.event_id = q.event_id
where q.at is not null
group by event_id, open_minute
