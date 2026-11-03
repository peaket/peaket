-- P6 결제-발권 불일치 ④(ADR-0106 '결제사 승인을 주문 쪽이 받지 못한 경우'): 결제사(시뮬레이터) 원장에는 승인이 있고 다 취소되지 않았는데,
-- 결제 원장에는 그 주문·결제사의 승인이 없다. 승인 뒤 정한 시간(기본 60초 [가정])이 지난 것만 센다(결과 모름 해소를 기다린다).
WITH prm AS (SELECT * FROM pg_temp.inv_params),
c AS (
  SELECT r.pg, r.payment_ref, r.approved_at,
         CASE WHEN r.pg = 'PORTONE' THEN regexp_replace(r.order_ref, '^pay-', '') ELSE r.order_ref END AS order_ref
  FROM pg_temp.rec_pg_charge r
  WHERE r.approved_at IS NOT NULL AND r.canceled_amount < r.amount
)
SELECT c.pg || ':' || c.payment_ref AS subject,
       format('order=%s approved_at=%s', c.order_ref, c.approved_at) AS detail
FROM c CROSS JOIN prm
WHERE c.approved_at + prm.enqueue_within < prm.as_of
  AND NOT EXISTS (SELECT 1 FROM pg_temp.payment p WHERE p.order_id::text = c.order_ref AND p.pg = c.pg AND p.approved_at IS NOT NULL)
ORDER BY 1;
