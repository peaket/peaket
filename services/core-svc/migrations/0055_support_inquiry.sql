-- F-06-5 core-svc 고객 문의(0055). 문의와 기록, 접수 번호·멱등 키·CS 건 연결·3년 파기 시각을 둔다.
-- 계좌번호 원문은 본문에만 두고(저장값 불변), 로그·Outbox·응답에는 싣지 않는다.
CREATE TABLE IF NOT EXISTS "inquiry" (
  "id" uuid PRIMARY KEY,
  "number" text NOT NULL UNIQUE,
  "account_id" uuid NOT NULL,
  "category" text NOT NULL,
  "order_ref" text,
  "order_summary" text,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "status" text NOT NULL,
  "case_id" uuid,
  "request_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "answered_at" timestamptz,
  "fan_viewed_at" timestamptz,
  "closed_at" timestamptz,
  "purge_at" timestamptz,
  "progress_due_at" timestamptz,
  "result_due_at" timestamptz NOT NULL,
  CONSTRAINT "inquiry_category_check" CHECK ("category" IN ('BOOKING_PAYMENT','CANCEL_REFUND','TRANSFER','ENTRY','ACCOUNT','AUTOMATED_DECISION','SELLER_DISPUTE','MINOR_CONTRACT_CANCEL','MERCH','MODERATION_APPEAL','RESALE_POST_REPORT','OTHER')),
  CONSTRAINT "inquiry_status_check" CHECK ("status" IN ('RECEIVED','IN_PROGRESS','ANSWERED','CLOSED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inquiry_message" (
  "id" uuid PRIMARY KEY,
  "inquiry_id" uuid NOT NULL REFERENCES "inquiry"("id") ON DELETE CASCADE,
  "author_kind" text NOT NULL,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "request_key" text,
  "request_hash" text,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "inquiry_message_author_check" CHECK ("author_kind" IN ('FAN','AGENT','SYSTEM')),
  CONSTRAINT "inquiry_message_kind_check" CHECK ("kind" IN ('MESSAGE','PROGRESS','ANSWER'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inquiry_account_created_idx" ON "inquiry" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inquiry_status_purge_idx" ON "inquiry" ("status", "purge_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inquiry_case_idx" ON "inquiry" ("case_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inquiry_request_key_idx" ON "inquiry" ("account_id", "request_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inquiry_message_inquiry_idx" ON "inquiry_message" ("inquiry_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inquiry_message_request_key_idx" ON "inquiry_message" ("inquiry_id", "request_key");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inquiry" TO core_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inquiry_message" TO core_app;
--> statement-breakpoint
-- 문의·추가 문의를 Outbox에 같은 트랜잭션으로 넣는다(0004는 core_app에 SELECT만 준다). 시퀀스는 seq 기본값이 쓴다.
GRANT INSERT ON "outbox" TO core_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE "outbox_seq" TO core_app;
