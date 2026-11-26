-- F-04-15 support 소명 표(core DB appeal, docs/data.md §2 '소명', docs/features/transfer-refund.md §7.1).
-- F-04-15 계획 §5: core-svc 최신 0047 다음 0048. 동결 로컬 번호다(ADR-0386 결정 5).
CREATE TABLE "appeal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"result" text,
	"case_id" uuid,
	"submitted_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "appeal_kind_check" CHECK ("appeal"."kind" in ('RESTRICTION', 'RECLAIM', 'FRAUD_CASE')),
	CONSTRAINT "appeal_status_check" CHECK ("appeal"."status" in ('SUBMITTED', 'DECIDED', 'INVALID')),
	CONSTRAINT "appeal_result_check" CHECK ("appeal"."result" is null or "appeal"."result" in ('LIFTED', 'KEPT', 'NOT_RECLAIMED', 'RECLAIMED', 'ACCEPTED', 'REJECTED')),
	CONSTRAINT "appeal_body_length_check" CHECK (char_length("body") <= 2000)
);
--> statement-breakpoint
CREATE INDEX "appeal_account_submitted_idx" ON "appeal" USING btree ("account_id","submitted_at");
--> statement-breakpoint
CREATE INDEX "appeal_target_id_idx" ON "appeal" USING btree ("target_id");
--> statement-breakpoint
-- 팬 경로(core_app): 자기 소명을 넣고·읽고·결과만 고친다. 계정 ID로만 거른다.
GRANT SELECT, INSERT, UPDATE ON "appeal" TO core_app;
