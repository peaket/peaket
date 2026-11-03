-- P5 결제-발권 불일치 ③ 승인 없는 발권(docs/features/payment.md §8 '발권은 됐는데 결제가 승인되지 않은 경우 0건', verification §2.1 payment ③):
-- 유효 티켓인데 그 주문에 살아 있는 승인(APPROVED·PARTIAL_CANCELED)이 없거나, 티켓을 낸 주문이 없거나, 그 티켓의 예매 취소가 환불까지 끝났다.
WITH valid AS (
  SELECT t.id FROM pg_temp.ticket t WHERE t.status IN ('ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'FLAGGED')
),
linked AS (
  SELECT v.id AS ticket_id, i.order_id
  FROM valid v
  LEFT JOIN pg_temp.order_item i ON i.ticket_id = v.id
)
SELECT l.ticket_id::text AS subject,
       CASE
         WHEN l.order_id IS NULL THEN 'no_order'
         WHEN EXISTS (SELECT 1 FROM pg_temp.order_cancellation c WHERE c.ticket_id = l.ticket_id AND c.status = 'REFUNDED') THEN format('refunded_cancellation order=%s', l.order_id)
         ELSE format('no_live_approval order=%s', l.order_id)
       END AS detail
FROM linked l
WHERE l.order_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM pg_temp.payment p WHERE p.order_id = l.order_id AND p.status IN ('APPROVED', 'PARTIAL_CANCELED'))
   OR EXISTS (SELECT 1 FROM pg_temp.order_cancellation c WHERE c.ticket_id = l.ticket_id AND c.status = 'REFUNDED')
ORDER BY 1;
