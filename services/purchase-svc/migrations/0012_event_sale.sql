-- 회차 판매 상태 표와 결제 중 셈 인덱스(docs/data.md §2 event_sale·§4 열세 번째 마이그레이션·§5.1, ADR-0122 '뒤에 정한 것', BUILD_ORDER PRF-144).
-- drizzle-kit이 만든 SQL 그대로다(표 정의는 src/modules/inventory/adapters/db/schema.ts). _journal.json의 when은 앞 마이그레이션(0011)보다 커야 적용되므로 손으로 올렸다.
-- event_sale: 회차마다 한 행, 판 번호 version 조건부로 쓴다. 정본 칸에 previous_status·sold_out_tiers·open_at·counted_at을 더한 까닭은 같은 판을 다시 낼 때 그 판의 값이 필요하기 때문이다.
-- seat_sale_pending_idx: 결제 중 셈(회차의 PENDING, 승인 기한 안)을 위한 부분 인덱스다. reserved_at까지 두어 오래 남은 PENDING을 틱마다 읽지 않는다. seat_sale의 status UPDATE는 이미 활성 유일 부분 인덱스 때문에 HOT 갱신이 아니라 이 인덱스로 HOT을 더 잃지 않는다.
-- 운영에 나가기 전이라 트랜잭션 안에서 만든다. 운영 뒤 큰 표의 인덱스는 CONCURRENTLY 파일(-- peaket:no-transaction)로 따로 만든다(docs/devops.md §7.2, 실행기 BUILD_ORDER BAS-060).
CREATE TABLE "event_sale" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"previous_status" text,
	"version" bigint NOT NULL,
	"sellable_seats" integer NOT NULL,
	"available" integer NOT NULL,
	"held" integer NOT NULL,
	"paying" integer NOT NULL,
	"sold_out_tiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"open_at" timestamp with time zone,
	"first_sold_out_at" timestamp with time zone,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"counted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_sale_status_check" CHECK ("event_sale"."status" in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED')),
	CONSTRAINT "event_sale_previous_status_check" CHECK ("event_sale"."previous_status" in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED')),
	CONSTRAINT "event_sale_version_check" CHECK ("event_sale"."version" >= 1),
	CONSTRAINT "event_sale_counts_check" CHECK ("event_sale"."sellable_seats" >= 0 and "event_sale"."available" >= 0 and "event_sale"."held" >= 0 and "event_sale"."paying" >= 0 and "event_sale"."reopen_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "seat_sale_pending_idx" ON "seat_sale" USING btree ("event_id","reserved_at") WHERE "seat_sale"."status" = 'PENDING';