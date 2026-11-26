-- core-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 core_app, Outbox 릴레이 core_outbox_relay, 정비 core_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_app') THEN CREATE ROLE "core_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_outbox_relay') THEN CREATE ROLE "core_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_maintenance') THEN CREATE ROLE "core_maintenance" NOLOGIN; END IF; END $$;

GRANT SELECT ON outbox TO "core_outbox_relay";
GRANT UPDATE (sent_at) ON outbox TO "core_outbox_relay";

GRANT MAINTAIN ON "production" TO "core_maintenance";
GRANT DELETE ON "production" TO "core_maintenance";
GRANT MAINTAIN ON "event" TO "core_maintenance";
GRANT DELETE ON "event" TO "core_maintenance";
GRANT MAINTAIN ON "review" TO "core_maintenance";
GRANT DELETE ON "review" TO "core_maintenance";
GRANT MAINTAIN ON "search_document" TO "core_maintenance";
GRANT DELETE ON "search_document" TO "core_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "core_maintenance";
