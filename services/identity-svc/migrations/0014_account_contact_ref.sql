-- 조사용 연락처 가명(docs/features/identity.md §9.1 '조사용 값의 첫 구현', docs/data.md account_contact_ref, ADR-0171, BUILD_ORDER BOT-045).
-- 새 표라 기본 키·CHECK·외래키를 바로 만든다. 원문 번호·이메일은 두지 않는다.
CREATE TABLE "account_contact_ref" (
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_contact_ref_account_id_kind_pk" PRIMARY KEY("account_id","kind"),
	CONSTRAINT "account_contact_ref_kind_check" CHECK ("account_contact_ref"."kind" in ('PHONE', 'EMAIL'))
);
--> statement-breakpoint
ALTER TABLE "account_contact_ref" ADD CONSTRAINT "account_contact_ref_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;