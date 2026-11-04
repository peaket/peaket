-- 본인확인 키 판·만 14세·다른 계정 시도·재통과(docs/features/identity.md §5 '키 판·만 14세…', BUILD_ORDER BOT-020).
-- 상태·사유 칸의 CHECK는 NOT VALID로 더하고 다음 파일에서 따로 검증한다(docs/devops.md §7.2). 새 표의 인덱스는 빈 표라 바로 만든다.
CREATE TABLE "identity_conflict_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempted_account_id" uuid NOT NULL,
	"existing_account_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_attempt" DROP CONSTRAINT "verification_attempt_status_check";--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD COLUMN "session_id" uuid;--> statement-breakpoint
CREATE INDEX "identity_conflict_attempt_attempted_idx" ON "identity_conflict_attempt" USING btree ("attempted_account_id");--> statement-breakpoint
CREATE INDEX "identity_conflict_attempt_existing_idx" ON "identity_conflict_attempt" USING btree ("existing_account_id");--> statement-breakpoint
CREATE INDEX "identity_conflict_attempt_at_idx" ON "identity_conflict_attempt" USING btree ("attempted_at");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_closure_reason_check" CHECK ("account"."closure_reason" is null or "account"."closure_reason" in ('UNDER_14')) NOT VALID;--> statement-breakpoint
ALTER TABLE "verification_attempt" ADD CONSTRAINT "verification_attempt_status_check" CHECK ("verification_attempt"."status" in ('PENDING', 'VERIFIED', 'CANCELLED', 'FAILED', 'DUPLICATE_ACCOUNT', 'PROVIDER_DOWN', 'UNDER_14')) NOT VALID;