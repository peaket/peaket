-- 입장 키 알림 보낼 표(docs/data.md device_key_notice, ADR-0363 결정 4, docs/features/notify.md §4.7, BUILD_ORDER GAT-020).
-- migrations/0012: 0011_ticket_issue_guard 뒤에 온다. migrateTicket이 파일 이름 순으로 적용한다.
-- 재발급(REISSUE, 키가 있던 티켓의 ISSUE 교체)과 입장 시작 뒤 첫 등록이 성공하면 등록과 같은 트랜잭션에 한 행을 적는다.
-- ticket-svc 보내기 반복이 보내지 않은 행을 FOR UPDATE SKIP LOCKED로 잡아 core-svc POST /internal/v1/notify/ticket-events로 보내고,
-- 2xx·422면 sent_at을 적고 그 밖은 1분·5분·30분 [가정] 뒤 다시 보낸다. 보낸 행은 7일 [가정] 뒤 지운다. 연락처·키 값은 두지 않는다.
CREATE TABLE IF NOT EXISTS "device_key_notice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_key_id" uuid NOT NULL REFERENCES "device_key"("id"),
	"ticket_id" uuid NOT NULL REFERENCES "ticket"("id"),
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "device_key_notice_type_check" CHECK ("type" IN ('DEVICE_KEY_REISSUED', 'DEVICE_KEY_LATE_ISSUE')),
	CONSTRAINT "device_key_notice_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "device_key_notice_device_key_uq" ON "device_key_notice" ("device_key_id");
CREATE INDEX IF NOT EXISTS "device_key_notice_due_idx" ON "device_key_notice" ("next_attempt_at") WHERE "sent_at" IS NULL;
