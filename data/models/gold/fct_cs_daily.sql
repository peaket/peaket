{{ config(order_by='(event_id, run_id, day)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F13 CS(날짜별, analytics §5.2). 원천은 마감 실행기가 싣는 운영 기록 파일 brz_ops_case(F-04-6)다. 아직 원천이 없어 빈 표로 만든다(원천 없음)
select '' as event_id, today() as day, '' as kind, '' as outcome, toUInt64(0) as cases, toInt64(0) as handle_sec, today() as open_date, {{ gold_cols() }}
where 0
