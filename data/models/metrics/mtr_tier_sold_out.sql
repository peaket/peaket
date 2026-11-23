{{ config(materialized='view') }}
-- 등급별 매진 시각(지표 6, analytics §6.3, F-04-5): 현재 판의 등급마다 누적 판매 좌석이 등급 좌석 수에 닿은 첫 오픈 기준 분(없으면 NULL).
-- 공연 리포트 판매 곡선과 파트너 판매 요약(partner_sales_gold, F-04-7)의 '매진 시각'이 읽는다
{{ tier_sold_out(current_run()) }}
