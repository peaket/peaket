{{ config(order_by='(event_id, run_id, day)', partition_by='toYYYYMM(open_date)', ttl='open_date + INTERVAL 2 YEAR') }}
-- F14 비용(날짜별, analytics §5.2). 비용 내보내기 원천(brz_cost)이 포트폴리오에 없다(analytics §14). 빈 표로 만든다(원천 없음)
select '' as event_id, today() as day, '' as item, toInt64(0) as amount, today() as open_date, {{ gold_cols() }}
where 0
