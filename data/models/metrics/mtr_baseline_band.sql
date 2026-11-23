{{ config(materialized='view') }}
-- 같은 규모 기준선(analytics §6.4, 기술 검토 낮음-044, F-04-5): 회차 현재 판의 지표마다 같은 규모 등급·최근 2년 확정 회차(그 회차 제외)의 범위·중앙값·사분위.
-- 회차 수 n < 3이면 모양 NONE(기준선 없음), 3~9 RANGE(근거 약함), 10 이상 IQR. 공연 리포트 카드·판매 곡선이 겹쳐 보인다
{{ baseline_band("select m.event_id as event_id, m.metric as metric, m.dim as dim, e.size_grade as size_grade, e.open_date as open_date from " ~ ref('metric_value') ~ " as m inner join (select event_id, run_id, size_grade, open_date from " ~ ref('dim_event') ~ " where " ~ current_run() ~ ") as e on e.event_id = m.event_id and e.run_id = m.run_id where " ~ current_run('m')) }}
