-- F-06-8 예매 확정 알림의 문안 판(ADR-0388, docs/data.md notification_job·notification_delivery).
-- 만든 때의 판은 notification_job.template_version, 실제로 그린 판은 notification_delivery.template_version에 남긴다.
-- held_event는 0000_catalog에 이미 있다(ADR-0142). 이 기능은 그 표를 보류 사유로 쓴다.
ALTER TABLE "notification_job" ADD COLUMN "template_version" text;
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "template_version" text;
