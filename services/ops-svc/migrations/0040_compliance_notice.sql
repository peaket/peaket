-- F-07-11(LCH-160): 법정 통보 접수·차단·철회 표. docs/data.md §2 takedown_notice·takedown_notice_action.
-- (requested_by, idempotency_key)와 (notice_id, action, idempotency_key)가 멱등 범위다.
-- 행 지우기는 주지 않는다(법정 기록). ops_app은 읽기·넣기·상태 고치기만 한다.
CREATE TABLE "takedown_notice" (
  "id" uuid PRIMARY KEY,
  "requested_by" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "requester" text NOT NULL,
  "agency_name" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "deadline" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "review_ids" jsonb NOT NULL,
  "summary" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'OPEN' NOT NULL,
  "taken_down_at" timestamp with time zone,
  "withdrawn_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "takedown_notice_status_check" CHECK ("status" in ('OPEN', 'TAKEN_DOWN', 'WITHDRAWN')),
  CONSTRAINT "takedown_notice_deadline_check" CHECK ("deadline" in ('H24', 'H10')),
  CONSTRAINT "takedown_notice_requester_check" CHECK ("requester" in ('AGENCY', 'POLICE')),
  CONSTRAINT "takedown_notice_agency_check" CHECK (char_length("agency_name") between 1 and 100),
  CONSTRAINT "takedown_notice_summary_check" CHECK (char_length("summary") <= 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "takedown_notice_requested_idempotency_uq" ON "takedown_notice" USING btree ("requested_by", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "takedown_notice_status_due_idx" ON "takedown_notice" USING btree ("status", "due_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "takedown_notice_due_idx" ON "takedown_notice" USING btree ("due_at");
--> statement-breakpoint
CREATE TABLE "takedown_notice_action" (
  "id" uuid PRIMARY KEY,
  "notice_id" uuid NOT NULL,
  "action" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "request_hash" bytea NOT NULL,
  "reason" text NOT NULL,
  "actor_ref" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "takedown_notice_action_action_check" CHECK ("action" in ('TAKEDOWN', 'WITHDRAWAL')),
  CONSTRAINT "takedown_notice_action_reason_check" CHECK (char_length("reason") between 1 and 2000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "takedown_notice_action_notice_action_key_uq" ON "takedown_notice_action" USING btree ("notice_id", "action", "idempotency_key");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "takedown_notice", "takedown_notice_action" TO ops_app;
-- 0015의 ALTER DEFAULT PRIVILEGES가 새 표에 DELETE를 미리 준다. 법정 기록은 지우지 않으므로 되돌린다.
REVOKE DELETE ON "takedown_notice", "takedown_notice_action" FROM ops_app;
