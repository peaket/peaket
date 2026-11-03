-- M5 정산: 정산서 판매 대금 = 그 판이 쓴 대사 완료 승인 합(J-T25, settlement §4.1). 회차 정산서(EVENT)마다
-- ① 판매 대금이 계산 원본 목록의 GROSS 합과 같고 ② 쓴 승인은 모두 그 회차·결제사의 승인이며 금액이 같고, 뺀 결제 목록에 없고,
-- 승인 날짜(KST)의 일일 대사가 DONE이다. 상품 정산서(PRODUCT)는 굿즈 주문 원장이 생기는 커머스 단계에서 더한다.
WITH g AS (
  SELECT ss.statement_id, sum(ss.amount) AS gross
  FROM pg_temp.statement_source ss
  WHERE ss.kind = 'GROSS'
  GROUP BY ss.statement_id
),
line AS (
  SELECT ss.statement_id, ss.source_id,
         CASE
           WHEN p.id IS NULL THEN 'payment_missing'
           WHEN p.approved_at IS NULL THEN 'not_approved'
           WHEN p.event_id IS DISTINCT FROM s.event_id OR p.pg <> s.pg THEN 'other_event_or_pg'
           WHEN ss.amount <> p.amount THEN 'amount_mismatch'
           WHEN coalesce(s.excluded_payments, '[]'::jsonb) ? p.id::text THEN 'excluded'
           WHEN NOT EXISTS (
             SELECT 1 FROM pg_temp.reconciliation_run r
             WHERE r.pg = s.pg AND r.status = 'DONE' AND r.recon_date = (p.approved_at AT TIME ZONE 'Asia/Seoul')::date
           ) THEN 'not_reconciled'
         END AS reason
  FROM pg_temp.statement_source ss
  JOIN pg_temp.settlement_statement s ON s.id = ss.statement_id
  LEFT JOIN pg_temp.payment p ON p.id = ss.payment_id
  WHERE ss.kind = 'GROSS' AND s.kind = 'EVENT'
)
SELECT s.id::text AS subject, format('gross_amount=%s sources=%s', s.gross_amount, coalesce(g.gross, 0)) AS detail
FROM pg_temp.settlement_statement s
LEFT JOIN g ON g.statement_id = s.id
WHERE s.kind = 'EVENT' AND s.gross_amount <> coalesce(g.gross, 0)
UNION ALL
SELECT line.statement_id || ':' || line.source_id AS subject, line.reason AS detail
FROM line
WHERE line.reason IS NOT NULL
ORDER BY 1, 2;
