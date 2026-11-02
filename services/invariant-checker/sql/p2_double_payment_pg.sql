-- P2 이중 결제(결제사 원장): 시뮬레이터(결제사) 원장에서 한 주문의 승인이 둘 이상이다. 결제사를 건너도 센다(결제 접수 뒤 결제사 바뀜).
-- 포트원 결제 ID는 pay-{주문 ID}라 접두어를 벗긴다(docs/features/payment.md §2.1 '주문 식별자 재사용').
WITH c AS (
  SELECT CASE WHEN r.pg = 'PORTONE' THEN regexp_replace(r.order_ref, '^pay-', '') ELSE r.order_ref END AS order_ref, r.pg
  FROM pg_temp.rec_pg_charge r
  WHERE r.approved_at IS NOT NULL
)
SELECT c.order_ref AS subject,
       format('approvals=%s pgs=%s', count(*), string_agg(DISTINCT c.pg, ',')) AS detail
FROM c
GROUP BY c.order_ref
HAVING count(*) > 1
ORDER BY 1;
