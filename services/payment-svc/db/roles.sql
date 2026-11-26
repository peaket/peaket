-- payment-svc DB 역할(BAS-060, F-09-2). 실행기가 마이그레이션 뒤에 적용한다.
-- 앱 DML 역할 payment_app, Outbox 릴레이 payment_outbox_relay, 정비 payment_maintenance.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_app') THEN CREATE ROLE "payment_app" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_outbox_relay') THEN CREATE ROLE "payment_outbox_relay" NOLOGIN; END IF; END $$;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_maintenance') THEN CREATE ROLE "payment_maintenance" NOLOGIN; END IF; END $$;

GRANT SELECT ON outbox TO "payment_outbox_relay";
GRANT UPDATE (sent_at) ON outbox TO "payment_outbox_relay";

GRANT MAINTAIN ON "payment" TO "payment_maintenance";
GRANT DELETE ON "payment" TO "payment_maintenance";
GRANT MAINTAIN ON "payment_event" TO "payment_maintenance";
GRANT DELETE ON "payment_event" TO "payment_maintenance";
GRANT MAINTAIN ON "webhook_receipt" TO "payment_maintenance";
GRANT DELETE ON "webhook_receipt" TO "payment_maintenance";
GRANT MAINTAIN ON "reconciliation_diff" TO "payment_maintenance";
GRANT DELETE ON "reconciliation_diff" TO "payment_maintenance";

CREATE EXTENSION IF NOT EXISTS pgstattuple;
GRANT EXECUTE ON FUNCTION pgstattuple(regclass) TO "payment_maintenance";
