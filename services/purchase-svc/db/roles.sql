-- purchase-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 purchase_app, Outbox 릴레이 purchase_outbox_relay, 정비 purchase_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'purchase_app') THEN CREATE ROLE "purchase_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'purchase_outbox_relay') THEN CREATE ROLE "purchase_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'purchase_maintenance') THEN CREATE ROLE "purchase_maintenance" NOLOGIN; END IF; END $$;

GRANT SELECT ON outbox TO "purchase_outbox_relay";
GRANT UPDATE (sent_at) ON outbox TO "purchase_outbox_relay";
REVOKE UPDATE, DELETE ON order_event FROM "purchase_app";

GRANT MAINTAIN ON "purchase_order" TO "purchase_maintenance";
GRANT DELETE ON "purchase_order" TO "purchase_maintenance";
GRANT MAINTAIN ON "order_event" TO "purchase_maintenance";
GRANT DELETE ON "order_event" TO "purchase_maintenance";
GRANT MAINTAIN ON "seat_hold" TO "purchase_maintenance";
GRANT DELETE ON "seat_hold" TO "purchase_maintenance";
GRANT MAINTAIN ON "held_event" TO "purchase_maintenance";
GRANT DELETE ON "held_event" TO "purchase_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "purchase_maintenance";
