-- 상품 유형 표와 현장 수령 시간대(BUILD_ORDER LCH-010·LCH-020, BAT-600, ADR-0300 결정 1, ADR-0301 결정 4, docs/data.md product_type·pickup_slot).
-- 감독 배정 번호 0028(core-svc 0027~0028이 갈래 5 몫). drizzle-kit generate로 만든 뒤 기본 유형 행을 손으로 더했다.
-- 기본 유형 둘 MERCH(굿즈)·PARKING(주차권)은 판 1이다(V-T26의 '기본 유형 둘'). 셋째 유형은 행 하나와 스키마 판 하나로 더한다(DDL 없음).
-- 두 표는 core_app만 읽는다(기본 권한 SELECT). core_partner는 읽지 않는다: 파트너 상품 검사는 앱 연결로 유형을 읽는다.
CREATE TABLE "pickup_slot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"ticket_holders_only" boolean DEFAULT false NOT NULL,
	CONSTRAINT "pickup_slot_window_check" CHECK ("pickup_slot"."ends_at" > "pickup_slot"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "product_type" (
	"code" text PRIMARY KEY NOT NULL,
	"latest_schema_version" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "product_type_version_check" CHECK ("product_type"."latest_schema_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "pickup_slot" ADD CONSTRAINT "pickup_slot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pickup_slot_product_idx" ON "pickup_slot" USING btree ("product_id","event_id","ends_at");--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_pickup_slot_id_pickup_slot_id_fk" FOREIGN KEY ("pickup_slot_id") REFERENCES "public"."pickup_slot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merch_order" ADD CONSTRAINT "merch_order_pickup_slot_check" CHECK (("merch_order"."fulfillment" = 'PICKUP') = ("merch_order"."pickup_slot_id" is not null));--> statement-breakpoint
INSERT INTO "product_type" ("code", "latest_schema_version", "enabled") VALUES ('MERCH', 1, true), ('PARKING', 1, true);
