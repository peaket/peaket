-- core 회차 상태 반영(BUILD_ORDER GAT-110, BAT-420-rest, docs/features/transfer-refund.md §5 'core 회차 상태 반영'·'core 반영의 구현에서 정한 것', R-T41).
-- ops-svc가 부르는 내부 경로 POST /internal/v1/events/{eventId}/cancellation-status는 운영 역할(core_ops) 연결로 회차를 CANCELLED·POSTPONED로 쓴다.
-- 0012가 core_ops에 준 event 고치기 칸 목록(open_at·entry_opens_at·starts_at·ends_at·…·version)에 상태 칸만 더한다(행 정책 event_ops는 0012 그대로).
-- 번호는 갈래 3 몫이 없어 임시로 0029를 썼다(감독 확인 대기, BAT-420-rest 구현 보고).
GRANT UPDATE ("status") ON "event" TO core_ops;
