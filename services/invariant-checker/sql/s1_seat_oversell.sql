-- S1 오버셀(K2, QR-FS-1, S-T2): 한 좌석에 활성 판매(PENDING·SOLD)가 둘 이상이다. RETURNED는 세지 않는다.
-- 운영 스키마는 활성 판매 부분 유니크 인덱스로 이것을 막는다(docs/data.md seat_sale). 이 검사는 그 장치가 지켜졌는지 사후에 센다.
SELECT s.event_id || ':' || s.seat_id AS subject,
       format('active=%s orders=%s', count(*), string_agg(s.order_id::text, ',' ORDER BY s.order_id)) AS detail
FROM pg_temp.seat_sale s
WHERE s.status IN ('PENDING', 'SOLD')
GROUP BY s.event_id, s.seat_id
HAVING count(*) > 1
ORDER BY 1;
