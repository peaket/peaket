-- Q2 같은 세대 순번 중복(docs/verification.md §2.1 queue ②·§2.5): 같은 회차·세대·순번을 다른 사람 둘 이상이 성공으로 받았다.
-- 같은 사람이 다시 받은 같은 번호(1인 1순번의 재요청)는 중복이 아니다. 결과를 모르는 발급은 세지 않는다.
SELECT e.event_id || ':' || e.generation || ':' || e.seq AS subject,
       format('holders=%s requests=%s', count(DISTINCT e.account_ref), string_agg(DISTINCT e.request_id, ',')) AS detail
FROM pg_temp.rec_queue_entry e
WHERE e.result = 'ok'
GROUP BY e.event_id, e.generation, e.seq
HAVING count(DISTINCT e.account_ref) > 1
ORDER BY 1;
