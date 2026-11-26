-- identity-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 identity_app, Outbox 릴레이 identity_outbox_relay, 정비 identity_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_app') THEN CREATE ROLE "identity_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_outbox_relay') THEN CREATE ROLE "identity_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_maintenance') THEN CREATE ROLE "identity_maintenance" NOLOGIN; END IF; END $$;

GRANT SELECT ON outbox TO "identity_outbox_relay";
GRANT UPDATE (sent_at) ON outbox TO "identity_outbox_relay";

GRANT MAINTAIN ON "session" TO "identity_maintenance";
GRANT DELETE ON "session" TO "identity_maintenance";
GRANT MAINTAIN ON "refresh_token_hash" TO "identity_maintenance";
GRANT DELETE ON "refresh_token_hash" TO "identity_maintenance";
GRANT MAINTAIN ON "session_create_key" TO "identity_maintenance";
GRANT DELETE ON "session_create_key" TO "identity_maintenance";
GRANT MAINTAIN ON "verification_attempt" TO "identity_maintenance";
GRANT DELETE ON "verification_attempt" TO "identity_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "identity_maintenance";
