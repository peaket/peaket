{{ config(materialized='view') }}
-- 데이터 품질(analytics §7·§8.2 10, F-04-5): 회차 현재 판의 품질 검사 결과. 공연 리포트 '데이터 품질' 절이 읽는다
select event_id, run_id, check_name, status, failed_count, affects, detail, built_at as as_of
from {{ ref('quality_check') }} where {{ current_run() }}
