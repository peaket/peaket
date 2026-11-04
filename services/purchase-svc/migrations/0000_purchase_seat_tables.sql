-- purchase DB의 좌석 표 셋(docs/data.md §2·§4 '좌석 표 마이그레이션', BUILD_ORDER PRF-140 ①). drizzle-kit이 만든 SQL에서 seat_hold만 손으로 고쳤다.
-- seat_hold는 회차 ID(UUIDv7) 범위 월 파티션 표다(ADR-0083). Drizzle 0.45에는 파티션 선언이 없어 부모 표 문장 끝에 PARTITION BY를 손으로 붙였다.
-- DEFAULT 파티션은 두지 않는다. 첫 파티션부터는 scripts/migrate.mjs가 마이그레이션 직후 @peaket/platform의 ensureMonthlyPartitions로 만든다(날짜를 박은 첫 파티션은 배포 날짜와 어긋나 첫 쓰기가 실패한다).
-- 파티션 표의 기본 키와 유일 인덱스는 파티션 키 열(event_id)을 담아야 한다(PostgreSQL 18).
CREATE TABLE "purchase_quota" (
	"account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"used" integer NOT NULL,
	"limit_count" integer NOT NULL,
	CONSTRAINT "purchase_quota_pkey" PRIMARY KEY("account_id","event_id"),
	CONSTRAINT "purchase_quota_used_within_limit" CHECK ("purchase_quota"."used" >= 0 and "purchase_quota"."limit_count" >= 0 and "purchase_quota"."used" <= "purchase_quota"."limit_count")
);
--> statement-breakpoint
CREATE TABLE "seat_hold" (
	"event_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"fencing_token" bigint NOT NULL,
	"status" text NOT NULL,
	"kind" text DEFAULT 'FAN' NOT NULL,
	"priority_grant_id" uuid,
	"held_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seat_hold_pkey" PRIMARY KEY("event_id","seat_id","fencing_token"),
	CONSTRAINT "seat_hold_status_check" CHECK ("seat_hold"."status" in ('HELD', 'RELEASED', 'EXPIRED')),
	CONSTRAINT "seat_hold_kind_check" CHECK ("seat_hold"."kind" in ('FAN', 'PRIORITY'))
) PARTITION BY RANGE ("event_id");
--> statement-breakpoint
CREATE TABLE "seat_sale" (
	"event_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_until" timestamp with time zone,
	CONSTRAINT "seat_sale_pkey" PRIMARY KEY("event_id","seat_id","order_id"),
	CONSTRAINT "seat_sale_status_check" CHECK ("seat_sale"."status" in ('PENDING', 'SOLD', 'RETURNED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "seat_hold_active_key" ON "seat_hold" USING btree ("event_id","seat_id") WHERE "seat_hold"."status" = 'HELD';--> statement-breakpoint
CREATE UNIQUE INDEX "seat_sale_active_key" ON "seat_sale" USING btree ("event_id","seat_id") WHERE "seat_sale"."status" in ('PENDING', 'SOLD');