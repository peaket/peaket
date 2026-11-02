-- M3 정산: 미수금 남은 금액 = 금액 − 이동 기록 합 ≥ 0(settlement §7 '미수금 이동 기록', J-T24·J-T25). 되돌림(REVERSAL)은 되돌린 금액만큼 뺀다.
WITH m AS (
  SELECT r.receivable_id, sum(CASE WHEN r.kind = 'REVERSAL' THEN -r.amount ELSE r.amount END) AS moved
  FROM pg_temp.receivable_movement r
  GROUP BY r.receivable_id
)
SELECT r.id::text AS subject,
       format('amount=%s remaining=%s moved=%s', r.amount, r.remaining, coalesce(m.moved, 0)) AS detail
FROM pg_temp.partner_receivable r
LEFT JOIN m ON m.receivable_id = r.id
WHERE r.remaining <> r.amount - coalesce(m.moved, 0) OR r.remaining < 0
ORDER BY 1;
