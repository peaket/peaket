-- S2 판매 대상 좌석 수 초과(S-T2 '판매 좌석 수 ≤ 전체 좌석 수'): 회차의 활성 판매가 판매 대상 좌석 수(event_sale.sellable_seats)보다 많다.
SELECT s.event_id::text AS subject,
       format('active=%s sellable=%s', count(*), e.sellable_seats) AS detail
FROM pg_temp.seat_sale s
JOIN pg_temp.event_sale e ON e.event_id = s.event_id
WHERE s.status IN ('PENDING', 'SOLD')
GROUP BY s.event_id, e.sellable_seats
HAVING count(*) > e.sellable_seats
ORDER BY 1;
