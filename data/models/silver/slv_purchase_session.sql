-- 구매 세션 누적 스냅샷(analytics §5.4 slv_purchase_session): 구매 세션 가명 1행. 시작·끝 사건, 홀드 시도, 주문·결제·발권 시각을 잇는다.
-- 대기 기록(QueueEntryRecord)은 queue-svc가 아직 내지 않아(F-04-20은 QueueAggregate 몫만) 대기 칸은 비어 있을 수 있다.
{{ config(order_by='(event_id, purchase_session_ref)', partition_by='toYYYYMM(open_date)', ttl='toDateTime(source_loaded_at) + INTERVAL 90 DAY') }}
with s as (
    select event_id, purchase_session_ref,
           anyIf(admission_ref, record = 'PurchaseSessionStarted') as admission_ref,
           minIf(started_at, record = 'PurchaseSessionStarted') as started_at,
           maxIf(ended_at, record = 'PurchaseSessionEnded') as ended_at,
           anyIf(end_reason, record = 'PurchaseSessionEnded') as end_reason,
           max(source_loaded_at) as source_loaded_at
    from (select * from {{ ref('stg_purchase_session') }} where {{ event_filter() }} order by kafka_partition, kafka_offset limit 1 by event_key)
    group by event_id, purchase_session_ref
),
h as (
    select event_id, purchase_session_ref,
           count() as hold_attempts,
           minIf(occurred_at, result = 'HELD') as first_hold_at,
           argMin(result, occurred_at) as first_hold_result,
           any(mode) as assignment
    from {{ ref('slv_hold_attempt') }} where {{ event_filter() }}
    group by event_id, purchase_session_ref
),
o as (
    select event_id, purchase_session_ref,
           minIf(occurred_at, type = 'CREATED') as order_created_at,
           minIf(occurred_at, type = 'ACCEPTED') as payment_accepted_at,
           minIf(occurred_at, type = 'APPROVED') as approved_at,
           minIf(occurred_at, type = 'CONFIRMED') as confirmed_at,
           maxIf(length(items), type = 'CREATED') as tickets
    from {{ ref('slv_order') }} where {{ event_filter() }} and purchase_session_ref != ''
    group by event_id, purchase_session_ref
),
open_of as (
    select event_id, toDate(open_at) as open_day from {{ ref('stg_ref_event') }} where {{ event_filter() }}
)
select s.event_id as event_id, s.purchase_session_ref as purchase_session_ref, s.admission_ref, s.started_at, s.ended_at, s.end_reason,
       h.hold_attempts, h.first_hold_at, h.first_hold_result, h.assignment,
       o.order_created_at, o.payment_accepted_at, o.approved_at, o.confirmed_at, o.tickets,
       s.source_loaded_at,
       -- 파티션 키는 Nullable이면 안 된다(시작 사건이 없으면 끝 사건, 그것도 없으면 적재 날)
       if(op.event_id = '', toDate(coalesce(s.started_at, s.ended_at, s.source_loaded_at)), op.open_day) as open_date
from s
left join h on h.event_id = s.event_id and h.purchase_session_ref = s.purchase_session_ref
left join o on o.event_id = s.event_id and o.purchase_session_ref = s.purchase_session_ref
left join open_of as op on op.event_id = s.event_id
