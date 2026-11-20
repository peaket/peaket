-- BAT-045 BOT-152: 관리 세션 강제 종료의 request_id 멱등(AdminSessionService.TerminateAdminSessions).
-- request_id는 ops-svc가 정한 값이고, 같은 request_id로 다시 오면 세션을 다시 끝내지 않고 already_done을 돌려준다.
-- 표는 그대로 두고 admin_account_request.kind의 허용 값만 넓힌다(docs/data.md admin_account_request, ADR-0322).
ALTER TABLE admin_account_request DROP CONSTRAINT IF EXISTS admin_account_request_kind_check;
ALTER TABLE admin_account_request ADD CONSTRAINT admin_account_request_kind_check
  CHECK (kind IN ('INVITE', 'CHANGE_ROLE', 'REINVITE', 'REMOVE', 'DESIGNATE', 'REVOKE_DESIGNATION', 'TERMINATE_SESSIONS'));
