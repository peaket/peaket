-- 탈퇴의 첫 구현(docs/features/identity.md §8 '탈퇴의 첫 구현', docs/data.md reauth_token_use·§6 보존 전용 스키마, BUILD_ORDER BOT-030).
-- 새 칸은 NULL 허용이라 표를 다시 쓰지 않고, 새 표의 인덱스는 빈 표라 바로 만든다. 보존 전용 스키마를 서비스 역할이 읽지 못하게 하는 권한은 DB 역할을 나누는 단계가 더한다.
CREATE SCHEMA "retention";
--> statement-breakpoint
CREATE TABLE "reauth_token_use" (
	"jti" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"used_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention"."verification_record" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"source_record" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	"delete_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "closure_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "reauth_token_use_expires_idx" ON "reauth_token_use" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verification_record_delete_idx" ON "retention"."verification_record" USING btree ("delete_at");--> statement-breakpoint
-- BOT-020 뒤에 만 14세 미만으로 정리를 시작한 계정은 시작 시각이 없다. 정비가 고르지 못해 끝나지 않으므로 지금으로 채운다(새 맥락 리뷰 L1)
UPDATE "account" SET "closure_started_at" = now() WHERE "status" = 'WITHDRAWAL_PENDING' AND "closure_reason" = 'UNDER_14' AND "closure_started_at" IS NULL;
