-- 이의 제기·소명 계류와 계정 병합 이력(docs/features/identity.md §2.1 '계정 병합의 첫 구현', docs/data.md account_hold·account_merge, BUILD_ORDER BOT-042).
-- 새 표라 인덱스와 CHECK를 바로 만든다. account_hold는 ops 건 ID(source_ref)가 기본 키(멱등)이고, account_merge는 흡수 계정마다 한 줄이다.
CREATE TABLE "account_hold" (
	"source_ref" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"source_version" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_hold_kind_check" CHECK ("account_hold"."kind" in ('VERIFICATION_APPEAL', 'DISPUTE', 'APPEAL')),
	CONSTRAINT "account_hold_state_check" CHECK ("account_hold"."state" in ('OPEN', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "account_merge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"primary_account_id" uuid NOT NULL,
	"merged_account_id" uuid NOT NULL,
	"merged_provider" text NOT NULL,
	"moved_summary" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "account_merge_merged_account_id_unique" UNIQUE("merged_account_id")
);
--> statement-breakpoint
CREATE INDEX "account_hold_account_idx" ON "account_hold" USING btree ("account_id","state");--> statement-breakpoint
CREATE INDEX "account_merge_primary_idx" ON "account_merge" USING btree ("primary_account_id");