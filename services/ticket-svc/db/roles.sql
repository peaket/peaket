-- ticket-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 ticket_app, Outbox 릴레이 ticket_outbox_relay, 정비 ticket_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticket_app') THEN CREATE ROLE "ticket_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticket_outbox_relay') THEN CREATE ROLE "ticket_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticket_maintenance') THEN CREATE ROLE "ticket_maintenance" NOLOGIN; END IF; END $$;

-- ticket DB에는 Outbox 표가 아직 없다. 있는 DB에서만 릴레이 권한을 준다.
DO $$ BEGIN
  IF to_regclass('public.outbox') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON outbox TO ticket_outbox_relay';
    EXECUTE 'GRANT UPDATE (sent_at) ON outbox TO ticket_outbox_relay';
  END IF;
END $$;

GRANT MAINTAIN ON "ticket" TO "ticket_maintenance";
GRANT DELETE ON "ticket" TO "ticket_maintenance";
GRANT MAINTAIN ON "scan_event" TO "ticket_maintenance";
GRANT DELETE ON "scan_event" TO "ticket_maintenance";
GRANT MAINTAIN ON "scanner_change" TO "ticket_maintenance";
GRANT DELETE ON "scanner_change" TO "ticket_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "ticket_maintenance";
