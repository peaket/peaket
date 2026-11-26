-- ops-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 ops_app, Outbox 릴레이 ops_outbox_relay, 정비 ops_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN CREATE ROLE "ops_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_outbox_relay') THEN CREATE ROLE "ops_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_maintenance') THEN CREATE ROLE "ops_maintenance" NOLOGIN; END IF; END $$;

GRANT SELECT ON outbox TO "ops_outbox_relay";
GRANT UPDATE (sent_at) ON outbox TO "ops_outbox_relay";

GRANT MAINTAIN ON "cs_case" TO "ops_maintenance";
GRANT DELETE ON "cs_case" TO "ops_maintenance";
GRANT MAINTAIN ON "ops_alert" TO "ops_maintenance";
GRANT DELETE ON "ops_alert" TO "ops_maintenance";
GRANT MAINTAIN ON "audit_chain" TO "ops_maintenance";
GRANT DELETE ON "audit_chain" TO "ops_maintenance";
GRANT MAINTAIN ON "held_event" TO "ops_maintenance";
GRANT DELETE ON "held_event" TO "ops_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "ops_maintenance";
