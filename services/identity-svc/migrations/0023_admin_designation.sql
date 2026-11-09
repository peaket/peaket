-- 관리 계정 지정(docs/data.md admin_designation, docs/features/identity.md §6 '관리 계정 지정의 첫 구현', BUILD_ORDER BOT-151, ADR-0171 결정 7)과 멱등 기록 종류 DESIGNATE·REVOKE_DESIGNATION.
-- 살아 있는 지정은 (계정, 종류)마다 하나다(부분 고유 색인). admin_account_request는 아직 운영에 나가지 않은 작은 표라 CHECK를 바로 다시 만든다.
CREATE TABLE "admin_designation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"basis" text NOT NULL,
	"designated_by" uuid NOT NULL,
	"designated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_designation_kind_check" CHECK ("admin_designation"."kind" in ('ACCESS_REVIEWER', 'PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR'))
);
--> statement-breakpoint
ALTER TABLE "admin_account_request" DROP CONSTRAINT "admin_account_request_kind_check";--> statement-breakpoint
ALTER TABLE "admin_designation" ADD CONSTRAINT "admin_designation_admin_account_id_admin_account_id_fk" FOREIGN KEY ("admin_account_id") REFERENCES "public"."admin_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_designation_live_key" ON "admin_designation" USING btree ("admin_account_id","kind") WHERE "admin_designation"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "admin_designation_account_idx" ON "admin_designation" USING btree ("admin_account_id","revoked_at");--> statement-breakpoint
ALTER TABLE "admin_account_request" ADD CONSTRAINT "admin_account_request_kind_check" CHECK ("admin_account_request"."kind" in ('INVITE', 'CHANGE_ROLE', 'REINVITE', 'REMOVE', 'DESIGNATE', 'REVOKE_DESIGNATION'));