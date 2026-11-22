-- 명령 3(판매 일시정지)의 판·명령·바뀐 시각 칸(F-02-1 OPS-300, ADR-0365 결정 6·8, docs/data.md sale_control).
-- 판매 중지(revision·command_id)와 판을 따로 센다: 한 칸이면 다른 원장에서 온 두 종류가 서로를 막는다. 0은 한 번도 받지 않음이다.
ALTER TABLE "sale_control" ADD COLUMN "paused_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_control" ADD COLUMN "paused_command_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_control" ADD COLUMN "paused_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sale_control" ADD CONSTRAINT "sale_control_paused_revision_check" CHECK ("sale_control"."paused_revision" >= 0);
