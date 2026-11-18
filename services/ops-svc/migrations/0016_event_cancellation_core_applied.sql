-- BAT-420-rest GAT-110: core 회차 상태 반영의 다시 하기(docs/features/transfer-refund.md §5 'core 회차 상태 반영', docs/data.md event_cancellation_request, R-T41).
-- core_applied_at: core-svc가 회차 상태 반영(POST /internal/v1/events/{eventId}/cancellation-status)에 2xx로 답한 시각. 비어 있으면 1분 [가정]마다 다시 부른다.
-- core_apply_next_at: 다시 하기가 그 행을 잡은 뒤 다음에 볼 시각(잡기 뒤 미루기, 파드 여럿이 같은 행을 겹쳐 부르지 않게 한다).
-- core_apply_overdue_at: 확정 뒤 10분 [가정]이 지나도 비어 있어 SEV2 로그를 남긴 시각(요청마다 한 번).
-- 모두 빈 값 허용이고 옛 행은 채우지 않는다(운영 데이터가 없다. 옛 확정 행은 배포 뒤 다시 하기가 한 번 반영한다, core 쪽이 멱등이다).
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS core_applied_at timestamptz;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS core_apply_next_at timestamptz;
ALTER TABLE event_cancellation_request ADD COLUMN IF NOT EXISTS core_apply_overdue_at timestamptz;
-- 다시 하기 목록(Start까지 끝낸 확정 뒤 요청 가운데 반영하지 않은 것)만 받치는 부분 색인
CREATE INDEX IF NOT EXISTS event_cancellation_request_core_apply_idx ON event_cancellation_request (approved_at)
  WHERE core_applied_at IS NULL AND refund_job_state IS NOT NULL AND status IN ('APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED');
