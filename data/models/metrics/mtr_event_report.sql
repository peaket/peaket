{{ config(materialized='view') }}
-- 공연 리포트 데이터(analytics §8.2, F-04-7): 현재 판의 회차 한 줄에 지표 카드·결정 규칙 판정·데이터 품질을 묶는다.
-- ops-svc 리포트 생성기가 이 뷰와 F11만 읽어 JSON·Markdown을 만든다(자기 쿼리로 지표를 다시 계산하지 않는다).
-- metrics: (지표, 차원, 값, 분자, 분모, 표본, 기준선 중앙값, 기준선 1사분위, 기준선 3사분위, 확정 여부)
-- rule_checks: (규칙, TRIGGERED|NOT_TRIGGERED|DEFERRED, 보류 사유, 결정 기록 ID)
with ev as (
    select event_id, run_id, close_stage, built_at as as_of
    from {{ ref('fct_event_summary') }} where {{ current_run() }}
),
metrics_agg as (
    select m.event_id as event_id,
           groupArray(tuple(m.metric, m.dim, m.value, m.numerator, m.denominator, m.sample,
                            b.baseline_median, b.baseline_q1, b.baseline_q3, toUInt8(m.close_stage != 'R0'))) as metrics
    from {{ ref('mtr_event_metric') }} as m
    left join {{ ref('mtr_baseline_band') }} as b on b.event_id = m.event_id and b.metric = m.metric and b.dim = m.dim
    group by m.event_id
),
rules_agg as (
    select event_id,
           groupArray(tuple(rule_id, multiIf(verdict = 'HIT', 'TRIGGERED', verdict = 'HOLD', 'DEFERRED', 'NOT_TRIGGERED'),
                            hold_reason, decision_record_id)) as rule_checks
    from {{ ref('mtr_rule_check') }} group by event_id
),
qa as (
    select event_id, countIf(status = 'FAIL') as failed, count() as checks, groupUniqArrayArray(affects) as failed_metrics
    from {{ ref('mtr_data_quality') }} group by event_id
)
select ev.event_id as event_id, ev.close_stage as stage, ev.as_of as generated_at,
       ma.metrics as metrics,
       ra.rule_checks as rule_checks,
       toUInt8(ifNull(qa.failed, 0) = 0) as quality_coverage_ok,
       ifNull(qa.failed_metrics, CAST([] AS Array(String))) as quality_failed_metrics,
       toUInt64(ifNull(qa.checks, 0)) as quality_checks
from ev
left join metrics_agg as ma on ma.event_id = ev.event_id
left join rules_agg as ra on ra.event_id = ev.event_id
left join qa on qa.event_id = ev.event_id
