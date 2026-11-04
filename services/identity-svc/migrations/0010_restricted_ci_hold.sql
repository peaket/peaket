-- 이용 제한 중 탈퇴의 대조값 보관(docs/features/identity.md §8 '대조값 보관의 첫 구현', docs/data.md restricted_ci_hold, BUILD_ORDER BOT-035).
-- 새 표라 인덱스와 CHECK를 바로 만든다. 계정 외래키는 두지 않는다(탈퇴해도 until까지 남는다). 기본 키는 멱등 키 (계정, 사건)이다.
CREATE TABLE "restricted_ci_hold" (
	"ci_hmac" "bytea" NOT NULL,
	"ci_hmac_key_version" integer NOT NULL,
	"fraud_case_id" uuid NOT NULL,
	"state" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"source_account_id" uuid NOT NULL,
	"carried_account_id" uuid,
	"version" bigint NOT NULL,
	CONSTRAINT "restricted_ci_hold_source_account_id_fraud_case_id_pk" PRIMARY KEY("source_account_id","fraud_case_id"),
	CONSTRAINT "restricted_ci_hold_state_check" CHECK ("restricted_ci_hold"."state" in ('CASE_OPEN', 'RESTRICTED'))
);
--> statement-breakpoint
CREATE INDEX "restricted_ci_hold_ci_idx" ON "restricted_ci_hold" USING btree ("ci_hmac");--> statement-breakpoint
CREATE INDEX "restricted_ci_hold_carried_idx" ON "restricted_ci_hold" USING btree ("carried_account_id");--> statement-breakpoint
CREATE INDEX "restricted_ci_hold_until_idx" ON "restricted_ci_hold" USING btree ("until");