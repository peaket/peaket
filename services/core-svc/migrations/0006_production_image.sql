-- 공연 이미지(포스터 1장·상세 0~10장, ADR-0062 결정 38, ADR-0257, docs/data.md production_image, BUILD_ORDER HOT-190).
-- 표·제약·인덱스는 drizzle-kit generate가 만들었고, 권한과 행 보안(ADR-0241과 같은 방식)은 손으로 더했다.
CREATE TABLE "production_image" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"alt" text NOT NULL,
	"display_order" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "production_image_kind_check" CHECK ("production_image"."kind" in ('POSTER', 'DETAIL')),
	CONSTRAINT "production_image_alt_check" CHECK (char_length("production_image"."alt") between 1 and 300),
	CONSTRAINT "production_image_order_check" CHECK ("production_image"."display_order" between 0 and 9 and ("production_image"."kind" <> 'POSTER' or "production_image"."display_order" = 0)),
	CONSTRAINT "production_image_size_check" CHECK ("production_image"."width" between 1 and 20000 and "production_image"."height" between 1 and 20000),
	CONSTRAINT "production_image_version_check" CHECK ("production_image"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "production_image" ADD CONSTRAINT "production_image_production_promoter_fk" FOREIGN KEY ("production_id","promoter_id") REFERENCES "public"."production"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_image_poster_uq" ON "production_image" USING btree ("production_id") WHERE "production_image"."kind" = 'POSTER';--> statement-breakpoint
CREATE INDEX "production_image_production_idx" ON "production_image" USING btree ("production_id","display_order");
--> statement-breakpoint
-- 팬·관제 경로는 읽기만 한다(공연 상세의 포스터·상세 이미지 칸)
GRANT SELECT ON production_image TO core_app;
--> statement-breakpoint
-- 파트너 경로: 올리기(넣기)·고치기(대체 텍스트·순서·판)·지우기만이다. 공연·판매자·크기 칸은 고치지 못한다
GRANT SELECT, INSERT, DELETE ON production_image TO core_partner;
--> statement-breakpoint
GRANT UPDATE (alt, display_order, version, updated_at) ON production_image TO core_partner;
--> statement-breakpoint
ALTER TABLE production_image ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY production_image_partner_tenant ON production_image FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY production_image_app_read ON production_image FOR SELECT TO core_app USING (true);
