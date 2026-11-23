{{ config(materialized='view') }}
-- 지표 뷰(analytics §6.2·§8.2, F-04-5): 회차의 현재 판(gold.current_run) 지표 값. 공연 리포트 카드(F-04-7)가 읽는다.
-- 비율은 값과 분자·분모·표본 수를 함께, 숫자 지위는 마감 단계(close_stage)와 as_of(그 판을 만든 시각)로 보인다
select m.event_id as event_id, m.run_id as run_id, s.close_stage as close_stage, m.metric as metric, m.dim as dim,
       m.value as value, m.numerator as numerator, m.denominator as denominator, m.sample as sample, m.source_ok as source_ok,
       m.built_at as as_of
from {{ ref('metric_value') }} as m
inner join (select event_id, run_id, close_stage from {{ ref('fct_event_summary') }} where {{ current_run() }}) as s on s.event_id = m.event_id and s.run_id = m.run_id
where {{ current_run('m') }}
