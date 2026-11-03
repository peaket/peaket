-- M4 정산: 한 결제의 환급이 두 정산서에 들어가지 않는다(J-T25). 환급 하나(payment_cancel)가 SUPERSEDED가 아닌 정산서 판 둘 이상의
-- 계산 원본 목록(statement_source REFUND)에 있다. 다시 계산해 옛 판이 된 SUPERSEDED는 새 판과 함께 있어도 된다(settlement §4.1 '다시 계산').
SELECT ss.source_id::text AS subject,
       format('statements=%s', string_agg(ss.statement_id::text, ',' ORDER BY ss.statement_id)) AS detail
FROM pg_temp.statement_source ss
JOIN pg_temp.settlement_statement s ON s.id = ss.statement_id
WHERE ss.kind = 'REFUND' AND s.status <> 'SUPERSEDED'
GROUP BY ss.source_id
HAVING count(DISTINCT ss.statement_id) > 1
ORDER BY 1;
