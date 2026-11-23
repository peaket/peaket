{{ config(order_by='(event_id, run_id, cohort_minute, assignment, bot_class)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F3 퍼널 코호트(analytics §5.2): 회차 × 입장 분(구매 세션 시작) × 배정 방식 × 봇 범주. 단계 도달 수와 단계 사이 소요 시간 합.
-- 봇 범주는 구매 세션과 판정 기록을 잇는 대기 기록(QueueEntryRecord)이 아직 없어 '모름'이다. 작은 칸 합치기(5 [가정])
with o as ({{ open_of() }}),
s as (
    -- 정렬 키 칸(cohort_minute)은 Nullable이면 안 된다: 시작 사건을 못 받은 세션은 끝난 시각, 그것도 없으면 적재 시각으로 묶는다(slv_purchase_session open_date와 같은 차례)
    select s.*, {{ open_minute('ifNull(s.started_at, ifNull(s.ended_at, s.source_loaded_at))', or_event_time('o.ev_open_at', 'ifNull(s.started_at, ifNull(s.ended_at, s.source_loaded_at))')) }} as cohort_minute,
           if(o.event_id = '', toDate(ifNull(s.started_at, ifNull(s.ended_at, s.source_loaded_at))), o.open_day) as od
    from {{ ref('slv_purchase_session') }} as s left join o on o.event_id = s.event_id
    -- 시각 순서가 어긋난 세션은 격리한다(analytics §7, F-04-5). 그 수는 quality_check의 time_order 줄에 남는다
    where {{ event_filter('s.event_id') }} and {{ time_order_ok('s') }}
)
select event_id, cohort_minute, ifNull(assignment, '') as assignment, 'UNKNOWN' as bot_class,
       toUInt64(count()) as admitted,
       toUInt64(countIf(first_hold_result = 'HELD')) as first_hold,
       toUInt64(countIf(toYear(payment_accepted_at) >= 2000)) as payment_accepted,
       toUInt64(countIf(toYear(approved_at) >= 2000)) as approved,
       toUInt64(countIf(toYear(confirmed_at) >= 2000)) as issued,
       toInt64(sumIf(dateDiff('second', started_at, first_hold_at), toYear(first_hold_at) >= 2000)) as admit_to_hold_sec,
       toInt64(sumIf(dateDiff('second', first_hold_at, approved_at), toYear(approved_at) >= 2000 and toYear(first_hold_at) >= 2000)) as hold_to_approve_sec,
       any(od) as open_date,
       {{ gold_cols() }}
from s
group by event_id, cohort_minute, assignment
