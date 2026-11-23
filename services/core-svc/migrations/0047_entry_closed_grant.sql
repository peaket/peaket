-- 입장 기록 마감 알림(F-05-6, offline-gate §7.3 'core 알림')의 core_ops 권한.
-- 0012_ops_role.sql은 event의 판매·일정 칸만 UPDATE로 허용했고, entry_closed_at은 뒤에 생긴 칸이라 빠져 있었다.
-- ticket-svc 내부 경로 PUT /internal/v1/events/{eventId}/entry-closed가 이 칸만 쓴다. 다른 칸은 넓히지 않는다.
GRANT UPDATE (entry_closed_at) ON event TO core_ops;
