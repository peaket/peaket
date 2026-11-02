-- M1 정산: 완료한 지급 건 합계 = 정산서 지급액(PAID)(docs/features/settlement.md §13 J-T25, ADR-0129 중간-043).
SELECT s.id::text AS subject,
       format('payout_amount=%s completed=%s', s.payout_amount, coalesce(sum(p.amount), 0)) AS detail
FROM pg_temp.settlement_statement s
LEFT JOIN pg_temp.payout p ON p.statement_id = s.id AND p.status = 'COMPLETED'
WHERE s.status = 'PAID'
GROUP BY s.id, s.payout_amount
HAVING coalesce(sum(p.amount), 0) <> s.payout_amount
ORDER BY 1;
