{{ config(materialized='table', order_by='day') }}
-- 날짜 차원(analytics §5.3, 고정): 2025-01-01부터 2028-12-31까지. 영업일은 주말을 뺀 값이고 공휴일 달력은 payment·settlement와 같은 원천을 F-04-6에서 잇는다
select toDate('2025-01-01') + number as day, toDayOfWeek(day) as weekday, weekday <= 5 as business_day, 0 as holiday
from numbers(1461)
