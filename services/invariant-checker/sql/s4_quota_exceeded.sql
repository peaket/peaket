-- S4 1인 한도 초과(K2, docs/verification.md §2.1 seat ②): 한 계정이 한 회차에서 가진 활성 판매 좌석이 한도(purchase_quota.limit_count)보다 많다.
-- 판매 확정과 한도 차감은 같은 트랜잭션이라 한도 행이 없는 활성 판매도 위반으로 센다(docs/data.md §1 purchase).
WITH active AS (
  SELECT o.account_id, s.event_id, count(*) AS seats
  FROM pg_temp.seat_sale s
  JOIN pg_temp.purchase_order o ON o.id = s.order_id
  WHERE s.status IN ('PENDING', 'SOLD')
  GROUP BY o.account_id, s.event_id
)
SELECT a.account_id || ':' || a.event_id AS subject,
       format('seats=%s limit=%s', a.seats, coalesce(q.limit_count::text, 'none')) AS detail
FROM active a
LEFT JOIN pg_temp.purchase_quota q ON q.account_id = a.account_id AND q.event_id = a.event_id
WHERE q.limit_count IS NULL OR a.seats > q.limit_count
ORDER BY 1;
