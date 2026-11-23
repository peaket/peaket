{{ config(materialized='view') }}
-- 결정 규칙 판정의 현재 판(analytics §8.2 1, F-04-5): F12(fct_rule_check)에서 회차 현재 판의 행만. 공연 리포트 판정 표가 읽는다
select * from {{ ref('fct_rule_check') }} where {{ current_run() }}
