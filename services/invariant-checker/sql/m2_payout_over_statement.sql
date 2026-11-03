-- M2 정산: 한 정산서의 지급 건 합계 ≤ 그 판의 지급액(J-T25). 실패·취소한 지급 건은 새 지급 건(새 순번)으로 대신하므로 세지 않는다(settlement §13 J-T15).
SELECT s.id::text AS subject,
       format('payout_amount=%s payouts=%s', s.payout_amount, sum(p.amount)) AS detail
FROM pg_temp.settlement_statement s
JOIN pg_temp.payout p ON p.statement_id = s.id AND p.status NOT IN ('FAILED', 'CANCELED')
GROUP BY s.id, s.payout_amount
HAVING sum(p.amount) > s.payout_amount
ORDER BY 1;
