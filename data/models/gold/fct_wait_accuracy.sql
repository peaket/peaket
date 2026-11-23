{{ config(order_by='(event_id, run_id, eta_bucket, ratio_bucket)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- R2 동결(analytics §4.3, F-04-6): 마감 실행기가 onsale_run(R2 판)을 넘기면 다시 세지 않고 그 판의 행을 옮긴다(macros/close.sql)
{% set body %}
-- F7 대기 정확도(analytics §5.2): 회차 × 처음 예상 대기 구간 × 실제/예상 비율 구간. 실제 대기 = 차례 시각 − 진입 시각.
-- 대기 기록이 아직 없어 0행일 수 있다(F-04-7 범위 때 QueueEntryRecord)
with o as ({{ open_of() }}),
w as (
    select event_id, first_eta_sec, dateDiff('second', entered_at, turn_at) as actual_sec
    from {{ ref('slv_queue_entry') }} where {{ event_filter() }} and first_eta_sec > 0 and toYear(turn_at) >= 2000
)
select w.event_id as event_id,
       multiIf(w.first_eta_sec < 60, '<1m', w.first_eta_sec < 300, '1-5m', w.first_eta_sec < 900, '5-15m', '>=15m') as eta_bucket,
       multiIf(w.actual_sec / w.first_eta_sec < 0.5, '<0.5', w.actual_sec / w.first_eta_sec < 1.0, '0.5-1', w.actual_sec / w.first_eta_sec < 1.5, '1-1.5', w.actual_sec / w.first_eta_sec < 2, '1.5-2', '>=2') as ratio_bucket,
       toUInt64(count()) as people,
       any(if(o.event_id = '', today(), o.open_day)) as open_date,
       {{ gold_cols() }}
from w left join o on o.event_id = w.event_id
group by event_id, eta_bucket, ratio_bucket
{% endset %}
{{ onsale_or(body) }}
