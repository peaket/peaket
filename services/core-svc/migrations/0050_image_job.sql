-- F-10-2 이미지 작업 원장(0050, HOT-200, ADR-0148 결정 8, ADR-0257 결정 2, docs/data.md §2 image_job).
-- core-svc가 격리 원본을 쓴 뒤 이 표에 작업을 적고, core-svc 작업 워커가 FOR UPDATE SKIP LOCKED로 집어 image-worker에 맡긴다.
-- 원본 키로 멱등하고(source_key UNIQUE), 처리 시한 30초·검사 대기 60초·무응답 5초·10회 DEAD를 상태로 둔다.
CREATE TABLE "image_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"result_status" text,
	"width" integer,
	"height" integer,
	"derivative_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reject_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "image_job_source_key_uq" UNIQUE("source_key"),
	CONSTRAINT "image_job_kind_check" CHECK ("kind" in ('PRODUCTION', 'HOME_BANNER', 'REVIEW_PHOTO', 'CLEANUP')),
	CONSTRAINT "image_job_status_check" CHECK ("status" in ('PENDING', 'SCANNING', 'RETRYING', 'DONE', 'DEAD')),
	CONSTRAINT "image_job_result_status_check" CHECK ("result_status" is null or "result_status" in ('ACCEPTED', 'REJECTED', 'DELETED')),
	CONSTRAINT "image_job_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "image_job_due_idx" ON "image_job" ("next_attempt_at") WHERE "status" in ('PENDING', 'SCANNING', 'RETRYING');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "image_job" TO core_app;
