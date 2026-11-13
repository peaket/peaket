-- 판매 승인 LCH-080이 정하는 회차 규모와 휠체어석 확인 칸(ADR-0093, FR-023).
-- 회차 규모는 승인 때 회차마다 정하고, 휠체어석 확인은 승인 요청 본문의 confirmed=true를 옮긴 값이다.
ALTER TABLE "event" ADD COLUMN "scale" text;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_scale_check" CHECK ("event"."scale" is null or "event"."scale" in ('LARGE', 'MEDIUM', 'SMALL'));--> statement-breakpoint
ALTER TABLE "production" ADD COLUMN "accessible_seating_check" boolean DEFAULT false NOT NULL;
