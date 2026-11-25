-- 판매 승인 때 회차 결제사 지정 고정(R-T19, LCH-090, ADR-0062 결정 33, docs/features/payment.md §2.2).
-- 지정 없는 회차는 승인 시점의 플랫폼 기본값을 event 칸에 남긴다. 기본과 대체는 다르고, 대체는 없을 수 있다.
-- 동결 로컬 번호다(ADR-0386 결정 5). 출시 마이그레이션 목록에 넣지 않는다.
ALTER TABLE "event" ADD COLUMN "pg_primary" text;
--> statement-breakpoint
ALTER TABLE "event" ADD COLUMN "pg_fallback" text;
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_pg_primary_check" CHECK ("pg_primary" is null or "pg_primary" in ('TOSS', 'PORTONE'));
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_pg_fallback_check" CHECK ("pg_fallback" is null or "pg_fallback" in ('TOSS', 'PORTONE'));
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_pg_distinct_check" CHECK ("pg_fallback" is null or "pg_primary" is null or "pg_fallback" <> "pg_primary");
--> statement-breakpoint
-- 승인 저장소가 core_ops로 회차의 지정을 쓴다. 파트너는 이 칸을 쓰지 않는다(판매 조건이 아니라 운영 설정이다)
GRANT UPDATE ("pg_primary", "pg_fallback") ON "event" TO core_ops;
--> statement-breakpoint
-- 휠체어석 확인을 boolean에서 jsonb로 넓힌다(FR-023, LCH-090, docs/data.md production.accessible_seating_check).
-- 옛 true는 확인만 남은 값으로, false는 빈 객체로 옮긴다. 파트너(core_partner)가 요청 때 쓰는 권한은 0034 그대로다.
ALTER TABLE "production" ALTER COLUMN "accessible_seating_check" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "production" ALTER COLUMN "accessible_seating_check" TYPE jsonb USING (
  CASE WHEN "accessible_seating_check" THEN '{"confirmed":true}'::jsonb ELSE '{}'::jsonb END
);
--> statement-breakpoint
ALTER TABLE "production" ALTER COLUMN "accessible_seating_check" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_accessible_seating_object_check" CHECK (jsonb_typeof("accessible_seating_check") = 'object');
