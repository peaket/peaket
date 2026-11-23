-- 스캐너 회차 입장 정책 사본(F-05-4, offline-gate §6.3 'POLICY를 적는 곳', docs/data.md scanner_event_policy).
-- core-svc event.reentry_allowed의 사본이다. 목록·변경분 요청 때 core 값과 다르면 조건부로 바꾸고
-- 같은 트랜잭션에서 scanner_change(POLICY)를 적는다. policy_seq는 마지막으로 적은 POLICY 변경 번호이고 처음 만들 때 0이다.
CREATE TABLE IF NOT EXISTS scanner_event_policy (
  event_id uuid PRIMARY KEY,
  reentry_allowed boolean NOT NULL,
  policy_seq bigint NOT NULL DEFAULT 0,
  observed_at timestamptz NOT NULL,
  CONSTRAINT scanner_event_policy_policy_seq_check CHECK (policy_seq >= 0)
);
