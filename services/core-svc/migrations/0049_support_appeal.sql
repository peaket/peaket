-- F-06-4 core-svc support 소명 표(transfer-refund §7.1, data.md appeal). 소명 본문은 3년 뒤 파기 대상이다.
-- CS 처리함 건 요청은 기존 outbox 표에 support.cases-requested(JSON 바이트, 아브로 인코더 전)로 같은 트랜잭션에 쓴다.
CREATE TABLE IF NOT EXISTS "appeal" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "target_id" text NOT NULL,
  "body" text NOT NULL,
  "status" text NOT NULL DEFAULT 'SUBMITTED',
  "result" text,
  "result_note" text,
  "case_id" text,
  "submitted_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "dispatch_state" text NOT NULL DEFAULT 'PENDING',
  "dispatch_attempts" integer NOT NULL DEFAULT 0,
  "next_dispatch_at" timestamp with time zone,
  "dispatched_at" timestamp with time zone,
  CONSTRAINT "appeal_kind_check" CHECK ("kind" IN ('RESTRICTION', 'FRAUD_CASE', 'RECLAIM')),
  CONSTRAINT "appeal_status_check" CHECK ("status" IN ('SUBMITTED', 'DECIDED', 'INVALID')),
  CONSTRAINT "appeal_result_check" CHECK ("result" IS NULL OR "result" IN ('LIFTED', 'KEPT', 'NOT_RECLAIMED', 'RECLAIMED', 'ACCEPTED', 'REJECTED')),
  CONSTRAINT "appeal_dispatch_state_check" CHECK ("dispatch_state" IN ('PENDING', 'SENT', 'RETRY', 'FAILED')),
  CONSTRAINT "appeal_dispatch_attempts_check" CHECK ("dispatch_attempts" >= 0),
  CONSTRAINT "appeal_body_len_check" CHECK (char_length("body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_account_submitted_idx" ON "appeal" ("account_id", "submitted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_dispatch_idx" ON "appeal" ("status", "next_dispatch_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "appeal" TO core_app;
