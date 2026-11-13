-- 관람 후기·게시물 신고·운영자 조치(BUILD_ORDER BAT-585, docs/data.md `review`·`content_report`·`takedown_action`, ADR-0066).
-- 후기 사진(review_image)은 사진 올리기 단계가 더한다. 다른 논리 DB의 계정·주문·CS 건에는 외래키를 걸지 않는다.
CREATE TABLE "review" (
	"id" uuid PRIMARY KEY,
	"event_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"basis_order_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'VISIBLE' NOT NULL,
	"notice" text,
	"notice_until" timestamp with time zone,
	"content_fingerprint" text NOT NULL,
	"author_display" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "review_rating_check" CHECK ("review"."rating" between 1 and 5),
	CONSTRAINT "review_status_check" CHECK ("review"."status" in ('VISIBLE', 'HIDDEN', 'DELETED')),
	CONSTRAINT "review_notice_check" CHECK ("review"."notice" is null or "review"."notice" in ('RIGHTS_TEMP', 'POLICY'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "review_event_account_uq" ON "review" USING btree ("event_id", "account_id") WHERE "review"."status" <> 'DELETED';
--> statement-breakpoint
CREATE INDEX "review_event_idx" ON "review" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "review_fingerprint_idx" ON "review" USING btree ("content_fingerprint");
--> statement-breakpoint
CREATE INDEX "review_created_idx" ON "review" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE TABLE "content_report" (
	"id" uuid PRIMARY KEY,
	"target_kind" text DEFAULT 'REVIEW' NOT NULL,
	"target_id" uuid NOT NULL,
	"reporter_account_id" uuid NOT NULL,
	"category" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"rights_holder" boolean DEFAULT false NOT NULL,
	"notify_channel" text,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"outcome" text,
	"case_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"purge_at" timestamp with time zone NOT NULL,
	CONSTRAINT "content_report_target_kind_check" CHECK ("content_report"."target_kind" = 'REVIEW'),
	CONSTRAINT "content_report_category_check" CHECK ("content_report"."category" in ('SCALPING', 'MACRO', 'ABUSE', 'RIGHTS', 'ILLEGAL_FILMING', 'SPAM', 'OFF_TOPIC', 'OTHER')),
	CONSTRAINT "content_report_status_check" CHECK ("content_report"."status" in ('RECEIVED', 'IN_REVIEW', 'RESOLVED')),
	CONSTRAINT "content_report_outcome_check" CHECK ("content_report"."outcome" is null or "content_report"."outcome" in ('NO_ACTION', 'TEMP_BLOCKED', 'BLOCKED')),
	CONSTRAINT "content_report_notify_check" CHECK ("content_report"."notify_channel" is null or "content_report"."notify_channel" in ('APP', 'EMAIL'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_report_target_reporter_uq" ON "content_report" USING btree ("target_id", "reporter_account_id");
--> statement-breakpoint
CREATE INDEX "content_report_reporter_created_idx" ON "content_report" USING btree ("reporter_account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "content_report_target_idx" ON "content_report" USING btree ("target_id");
--> statement-breakpoint
CREATE TABLE "takedown_action" (
	"id" uuid PRIMARY KEY,
	"notice_id" uuid,
	"review_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"case_id" uuid,
	"hidden_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	CONSTRAINT "takedown_action_reason_check" CHECK ("takedown_action"."reason" in ('NOTICE', 'SAME_CONTENT', 'RIGHTS_TEMP', 'POLICY', 'FILMING_HOLD'))
);
--> statement-breakpoint
CREATE INDEX "takedown_action_review_idx" ON "takedown_action" USING btree ("review_id");
--> statement-breakpoint
CREATE INDEX "takedown_action_fingerprint_idx" ON "takedown_action" USING btree ("content_fingerprint");
--> statement-breakpoint
CREATE TABLE "review_hidden_fingerprint" (
	"fingerprint" text PRIMARY KEY,
	"notice_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
