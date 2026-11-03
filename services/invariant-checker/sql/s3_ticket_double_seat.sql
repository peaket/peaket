-- S3 한 좌석에 유효 티켓 둘 이상(오버셀의 발권 쪽 모습): 환불·무효가 아닌 티켓이 같은 회차·좌석에 둘 이상이다.
-- 유효 상태는 ISSUED·ACTIVE·TRANSFER_PENDING·CANCEL_REQUESTED·FLAGGED다(docs/data.md ticket.status). 좌석이 없는 티켓은 보지 않는다.
SELECT t.event_id || ':' || t.seat_id AS subject,
       format('valid=%s tickets=%s', count(*), string_agg(t.id::text, ',' ORDER BY t.id)) AS detail
FROM pg_temp.ticket t
WHERE t.status IN ('ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'CANCEL_REQUESTED', 'FLAGGED') AND t.seat_id IS NOT NULL
GROUP BY t.event_id, t.seat_id
HAVING count(*) > 1
ORDER BY 1;
