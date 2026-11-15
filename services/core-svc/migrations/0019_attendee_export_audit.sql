-- A2-19: 예매자 명단 다운로드 접속기록(2년 보존). attendee_export(30일)와 달리 행위자·사유·건수·형식을 남긴다.
CREATE TABLE "attendee_export_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"export_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"actor_display_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"reason" text NOT NULL,
	"format" text NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	CONSTRAINT "attendee_export_audit_format_check" CHECK ("attendee_export_audit"."format" in ('CSV', 'XLSX', 'PDF')),
	CONSTRAINT "attendee_export_audit_count_check" CHECK ("attendee_export_audit"."count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "attendee_export_audit_promoter_event_idx" ON "attendee_export_audit" USING btree ("promoter_id","event_id","created_at");
--> statement-breakpoint
GRANT SELECT, INSERT ON attendee_export_audit TO core_partner;
--> statement-breakpoint
ALTER TABLE attendee_export_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendee_export_audit_partner_tenant ON attendee_export_audit FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
