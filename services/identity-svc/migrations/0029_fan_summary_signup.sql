-- 팬 계정 요약과 가입 마무리(docs/data.md consent·account.nickname_key·session.terminated_reason, docs/features/identity.md §8, BUILD_ORDER BOT-047, ADR-0235, ADR-0203).
-- consent는 새 표라 외래키를 바로 건다. nickname_key·terminated_reason은 기본값 없는 null 허용 칸이라 표를 다시 쓰지 않는다.
-- account_nickname_key_key는 값이 있는 행만 담는 부분 인덱스다(새 칸이라 지금은 비어 있다). 운영에 나가기 전이라 트랜잭션 안에서 만든다. 운영 뒤에 큰 표의 인덱스는 CONCURRENTLY 파일로 따로 만든다(docs/devops.md §7.2).
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"notice_version" text NOT NULL,
	"channels" text,
	"agreed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "consent_account_kind_version_key" UNIQUE("account_id","kind","notice_version"),
	CONSTRAINT "consent_kind_check" CHECK ("consent"."kind" in ('TERMS', 'PRIVACY_REQUIRED', 'PRIVACY_PHONE', 'MARKETING'))
);
--> statement-breakpoint
ALTER TABLE "account" ADD COLUMN "nickname_key" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "terminated_reason" text;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_nickname_key_key" ON "account" USING btree ("nickname_key") WHERE "account"."nickname_key" is not null;