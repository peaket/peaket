-- F-06-5 ops-svc 팬 조회 접속기록(0041)과 CS 건 계정 연결.
-- 관리 계정이 가린 값을 열 때마다 사유·대상 칸·접속지·시각을 남긴다(data.md admin_data_access). 2년 보존.
CREATE TABLE IF NOT EXISTS "admin_data_access" (
  "id" uuid PRIMARY KEY,
  "admin_account_id" uuid NOT NULL,
  "actor_role" text NOT NULL,
  "promoter_id" uuid,
  "action" text NOT NULL,
  "target_kind" text NOT NULL,
  "event_id" uuid,
  "filter" jsonb,
  "occurred_at" timestamptz NOT NULL,
  "reason" text,
  "target_count" integer,
  "format" text,
  "source_ip" inet,
  "source_service" text NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  "retain_until" timestamptz NOT NULL,
  CONSTRAINT "admin_data_access_action_check" CHECK ("action" IN ('LIST','DOWNLOAD','VIEW_UNMASKED','DATA_EXPORT')),
  CONSTRAINT "admin_data_access_target_check" CHECK ("target_kind" IN ('ATTENDEE_LIST','SHIPPING_LIST','FAN_PROFILE','DATA_REQUEST'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_data_access_admin_idx" ON "admin_data_access" ("admin_account_id", "recorded_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_data_access_target_idx" ON "admin_data_access" ("target_kind", "occurred_at");
--> statement-breakpoint
ALTER TABLE "cs_case" ADD COLUMN IF NOT EXISTS "account_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_case_account_idx" ON "cs_case" ("account_id", "created_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_data_access" TO ops_app;
