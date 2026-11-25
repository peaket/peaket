-- F-04-12 IR-20: SetTransferLock.version은 사건 판과 분리한 단조 증가 값이다.
-- ticket-svc는 같은 사건의 더 큰 판만 잠금 표에 반영하고 같거나 작은 판은 UNCHANGED로 둔다
-- (docs/api/proto/peaket/ticket/v1/ticket.proto, services/ticket-svc/src/modules/ticket/domain/transfer.ts, R-T31 ④).
CREATE SEQUENCE IF NOT EXISTS fraud_lock_version_seq;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE fraud_lock_version_seq TO ops_app;
