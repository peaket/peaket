-- P1 이중 결제(결제 원장, QR-FS-6, NFR-005): 한 주문에 승인된 적 있는 결제(approved_at이 있음)가 둘 이상이다.
-- 운영 스키마는 payment.order_id UNIQUE로 막는다(ADR-0114). 이 검사는 그 장치가 지켜졌는지 사후에 센다.
SELECT p.order_id::text AS subject,
       format('approved_payments=%s pgs=%s', count(*), string_agg(DISTINCT p.pg, ',')) AS detail
FROM pg_temp.payment p
WHERE p.approved_at IS NOT NULL
GROUP BY p.order_id
HAVING count(*) > 1
ORDER BY 1;
