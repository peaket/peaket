-- P3 결제-발권 불일치 ①(ADR-0106, NFR-006, P-T39·P-T47): 결제사 승인 뒤 정한 시간(기본 60초 [가정]) 안에 주문이 발권 대기(APPROVED, 발권 재시도
-- 큐에 넣는 같은 트랜잭션)나 발권 완료(CONFIRMED)가 되지 않았다. 시작 시각은 결제사 승인 시각과 결과 모름 해소 시각 가운데 늦은 쪽이다
-- (P4가 쓰는 꼴, 소유자 결정 2026-11-11 (가), ADR-0266). UNKNOWN 해소의 RESOLVED 사건이 없으면 승인 시각만 쓴다.
-- 그 시간 안에 전액 취소된 결제(승인 금액 불일치 등의 바로 취소)는 뺀다. 아직 그 시간이 지나지 않은 결제는 세지 않는다.
-- 입금 오류로 되돌린 뒤 다시 입금되면 approved_at이 새로 쓰인다(BUILD_ORDER HOT-152). 주문 사건은 마지막 입금 대기 진입 뒤의 것만 본다(입금 대기로 들어가는 전이는 T10·T14·T21뿐이고 앞의 둘 앞에는 승인이 없어 T21과 같은 뜻이다).
WITH prm AS (SELECT * FROM pg_temp.inv_params),
base AS (
  SELECT pay.id, pay.order_id, pay.amount, pay.approved_at,
         (SELECT max(e.occurred_at) FROM pg_temp.payment_event e
            WHERE e.payment_id = pay.id AND e.type = 'RESOLVED') AS resolved_at
  FROM pg_temp.payment pay
  WHERE pay.approved_at IS NOT NULL
),
p AS (
  SELECT b.id, b.order_id, b.amount, b.approved_at, b.resolved_at,
         greatest(b.approved_at, coalesce(b.resolved_at, b.approved_at)) AS start_at,
         (SELECT min(e.occurred_at) FROM pg_temp.order_event e WHERE e.order_id = b.order_id AND e.to_status IN ('APPROVED', 'CONFIRMED')
            AND e.seq > coalesce((SELECT max(w.seq) FROM pg_temp.order_event w WHERE w.order_id = b.order_id AND w.to_status = 'AWAITING_DEPOSIT'), 0)) AS queued_at,
         (SELECT coalesce(sum(c.amount), 0) FROM pg_temp.payment_cancel c
            WHERE c.payment_id = b.id AND c.status = 'CANCELED' AND c.canceled_at <= greatest(b.approved_at, coalesce(b.resolved_at, b.approved_at)) + prm.enqueue_within) AS canceled_in_window
  FROM base b CROSS JOIN prm
)
SELECT p.order_id::text AS subject,
       format('payment=%s approved_at=%s resolved_at=%s start_at=%s queued_at=%s', p.id, p.approved_at, coalesce(p.resolved_at::text, 'none'), p.start_at, coalesce(p.queued_at::text, 'none')) AS detail
FROM p CROSS JOIN prm
WHERE p.canceled_in_window < p.amount
  AND ((p.queued_at IS NULL AND prm.as_of > p.start_at + prm.enqueue_within) OR p.queued_at > p.start_at + prm.enqueue_within)
ORDER BY 1;
