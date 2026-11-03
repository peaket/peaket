-- Q1 차례 전 입장(docs/verification.md §2.5, ADR-0049, NFR-025): 입장 확정이 성공으로 끝난 때까지 기록된 serving의 최댓값보다
-- 큰 순번이 입장했다. 그때까지 기록된 serving이 없으면 아무도 입장할 차례가 아니다. 결과를 모르는 입장 확정은 세지 않는다(Jepsen 방식).
SELECT a.event_id || ':' || a.seq AS subject,
       format('account=%s request=%s seq=%s serving_max=%s ended_at=%s', a.account_ref, a.request_id, a.seq, coalesce(s.max_serving::text, 'none'), a.ended_at) AS detail
FROM pg_temp.rec_queue_admit a
LEFT JOIN LATERAL (
  SELECT max(v.serving) AS max_serving
  FROM pg_temp.rec_queue_serving v
  WHERE v.event_id = a.event_id AND v.observed_at <= a.ended_at
) s ON true
WHERE a.result = 'ok' AND (s.max_serving IS NULL OR a.seq > s.max_serving)
ORDER BY 1, 2;
