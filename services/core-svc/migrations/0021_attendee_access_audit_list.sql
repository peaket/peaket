-- W7-audit A2-19: 예매자 명단 접속기록(attendee_export_audit)을 명단 보기(LIST)와 내려받기(DOWNLOAD) 두 종류로 넓힌다(docs/data.md §2 '예매자 명단 내려받기 이력과 접속기록').
-- 보기 행은 내보내기 ID·사유·형식이 없고 조건(filter)을 남긴다. 기존 행은 기본값으로 DOWNLOAD·빈 조건이 된다. 권한·행 보안은 0019 그대로다(core_partner는 읽기·넣기만).
-- 접속지 정보(source_ip, 클라이언트 IP, 리뷰 R2)도 더한다. 0019로 들어간 옛 행은 비어 있으므로 CHECK는 NOT VALID로 두어 새 행에만 강제한다.
-- 0020 스냅숏에 이 표(0019)와 0017의 webhook_delivery 칸·인덱스가 빠져 있어 0021 스냅숏은 drizzle-kit으로 다시 만들었고, SQL은 이 표의 바뀐 부분만 손으로 썼다.
ALTER TABLE "attendee_export_audit" ALTER COLUMN "export_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ALTER COLUMN "format" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD COLUMN "action" text DEFAULT 'DOWNLOAD' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD COLUMN "filter" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD CONSTRAINT "attendee_export_audit_action_check" CHECK ("attendee_export_audit"."action" in ('LIST', 'DOWNLOAD'));--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD CONSTRAINT "attendee_export_audit_shape_check" CHECK (("attendee_export_audit"."action" = 'DOWNLOAD' and "attendee_export_audit"."export_id" is not null and "attendee_export_audit"."reason" is not null and "attendee_export_audit"."format" is not null) or ("attendee_export_audit"."action" = 'LIST' and "attendee_export_audit"."export_id" is null and "attendee_export_audit"."reason" is null and "attendee_export_audit"."format" is null));--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD COLUMN "source_ip" inet;--> statement-breakpoint
ALTER TABLE "attendee_export_audit" ADD CONSTRAINT "attendee_export_audit_source_ip_check" CHECK ("attendee_export_audit"."source_ip" IS NOT NULL) NOT VALID;
