-- P4 결제-발권 불일치 ②(ADR-0106, NFR-006, P-T39): 발권 대기가 된 주문이 발권 기한(기본 30분 [가정]) 안에 발권(CONFIRMED)이나
-- 보상(COMPENSATED)으로 끝나지 않았다. 기한이 지났는데 아직 발권 재시도 큐에 남은 행도 센다(ticket_issue_job.issue_due_at).
-- 입금 오류로 되돌린 뒤 다시 입금되면 approved_at이 새로 쓰인다(BUILD_ORDER HOT-152). 주문 사건은 마지막 입금 대기 진입 뒤의 것만 본다(P3와 같다).
-- 기한의 기준 시각(docs/verification.md §2.5 '판정', W9-fix2 PRF-182)은 purchase-svc가 발권 재시도 큐 행에 적는 기한과 같은 규칙이다
-- (purchase-svc approvalIssueDueAtMs, docs/features/payment.md §2 '승인 트랜잭션'·'입금 확인의 첫 구현'): 마지막 입금 대기 뒤 첫 주문 APPROVED 사건(반영)의
-- from_status가 UNKNOWN(T13)이나 AWAITING_DEPOSIT(T16)이면 greatest(결제사 승인 시각, 그 반영 시각), 그 밖(T9, 빈 값·반영 사건 없음 포함)이면 결제사 승인 시각이다.
-- 기한 = 기준 시각 + issue_deadline이고 비교는 '넘으면'(>)이다(기한 정각에 끝난 주문은 위반이 아니다).
WITH prm AS (SELECT * FROM pg_temp.inv_params),
p AS (
  SELECT pay.order_id, pay.approved_at,
         CASE WHEN a.from_status IN ('UNKNOWN', 'AWAITING_DEPOSIT') THEN greatest(pay.approved_at, a.occurred_at) ELSE pay.approved_at END AS base_at,
         (SELECT min(e.occurred_at) FROM pg_temp.order_event e WHERE e.order_id = pay.order_id AND e.to_status IN ('APPROVED', 'CONFIRMED') AND e.seq > l.last_wait) AS queued_at,
         (SELECT min(e.occurred_at) FROM pg_temp.order_event e WHERE e.order_id = pay.order_id AND e.to_status IN ('CONFIRMED', 'COMPENSATED') AND e.seq > l.last_wait) AS ended_at
  FROM pg_temp.payment pay
  CROSS JOIN LATERAL (SELECT coalesce(max(w.seq), 0) AS last_wait FROM pg_temp.order_event w WHERE w.order_id = pay.order_id AND w.to_status = 'AWAITING_DEPOSIT') l
  -- 마지막 입금 대기 뒤 첫 승인 반영(없으면 빈 값이라 T9 규칙)
  LEFT JOIN LATERAL (
    SELECT e.from_status, e.occurred_at FROM pg_temp.order_event e
     WHERE e.order_id = pay.order_id AND e.to_status = 'APPROVED' AND e.seq > l.last_wait
     ORDER BY e.seq LIMIT 1
  ) a ON true
  WHERE pay.approved_at IS NOT NULL
),
late AS (
  SELECT p.order_id, format('approved_at=%s base_at=%s ended_at=%s', p.approved_at, p.base_at, coalesce(p.ended_at::text, 'none')) AS detail
  FROM p CROSS JOIN prm
  WHERE p.queued_at IS NOT NULL
    AND ((p.ended_at IS NULL AND prm.as_of > p.base_at + prm.issue_deadline) OR p.ended_at > p.base_at + prm.issue_deadline)
),
job AS (
  SELECT j.order_id, format('issue_due_at=%s still_queued', j.issue_due_at) AS detail
  FROM pg_temp.ticket_issue_job j CROSS JOIN prm
  WHERE j.issue_due_at < prm.as_of AND NOT EXISTS (SELECT 1 FROM late l WHERE l.order_id = j.order_id)
)
SELECT order_id::text AS subject, detail FROM late
UNION ALL
SELECT order_id::text AS subject, detail FROM job
ORDER BY 1;
