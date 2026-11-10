-- 공연용 배치본(공연장 틀 복제)·구역·좌석·가격 등급(docs/data.md venue·section·seat·price_tier, ADR-0063·ADR-0260 결정 2, BUILD_ORDER HOT-240).
-- 표·제약·외래키는 drizzle-kit generate가 만들었고, 권한·행 보안·틀 확인 트리거(ADR-0241과 같은 방식)는 손으로 더했다.
CREATE TABLE "price_tier" (
	"venue_id" uuid NOT NULL,
	"tier_id" text NOT NULL,
	"promoter_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"display_order" integer NOT NULL,
	CONSTRAINT "price_tier_venue_id_tier_id_pk" PRIMARY KEY("venue_id","tier_id"),
	CONSTRAINT "price_tier_order_uq" UNIQUE("venue_id","display_order"),
	CONSTRAINT "price_tier_tier_id_check" CHECK (char_length("price_tier"."tier_id") between 1 and 30),
	CONSTRAINT "price_tier_name_check" CHECK (char_length("price_tier"."name") between 1 and 30),
	CONSTRAINT "price_tier_price_check" CHECK ("price_tier"."price" between 1 and 10000000),
	CONSTRAINT "price_tier_order_check" CHECK ("price_tier"."display_order" between 0 and 15)
);
--> statement-breakpoint
CREATE TABLE "seat" (
	"venue_id" uuid NOT NULL,
	"seat_key" uuid NOT NULL,
	"section_key" text NOT NULL,
	"promoter_id" uuid,
	"seat_index" integer NOT NULL,
	"row_label" text NOT NULL,
	"number" integer NOT NULL,
	"tier_id" text,
	"unavailable" boolean DEFAULT false NOT NULL,
	"wheelchair" boolean DEFAULT false NOT NULL,
	"gate_zone" text,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	CONSTRAINT "seat_venue_id_seat_key_pk" PRIMARY KEY("venue_id","seat_key"),
	CONSTRAINT "seat_index_uq" UNIQUE("venue_id","seat_index"),
	CONSTRAINT "seat_place_uq" UNIQUE("venue_id","section_key","row_label","number"),
	CONSTRAINT "seat_index_check" CHECK ("seat"."seat_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "section" (
	"venue_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"promoter_id" uuid,
	"sort_order" integer NOT NULL,
	"seat_index_from" integer,
	"seat_index_to" integer,
	"name" text NOT NULL,
	"level" text,
	"shape" jsonb NOT NULL,
	"editor_meta" jsonb,
	"label_x" integer,
	"label_y" integer,
	"default_tier" text,
	"gate_zone" text,
	CONSTRAINT "section_venue_id_section_key_pk" PRIMARY KEY("venue_id","section_key"),
	CONSTRAINT "section_order_uq" UNIQUE("venue_id","sort_order"),
	CONSTRAINT "section_order_check" CHECK ("section"."sort_order" >= 0),
	CONSTRAINT "section_range_check" CHECK (("section"."seat_index_from" is null) = ("section"."seat_index_to" is null) and ("section"."seat_index_from" is null or ("section"."seat_index_from" >= 0 and "section"."seat_index_from" <= "section"."seat_index_to")))
);
--> statement-breakpoint
CREATE TABLE "venue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"kind" text NOT NULL,
	"template_venue_id" uuid,
	"promoter_id" uuid,
	"canvas_width" integer,
	"canvas_height" integer,
	"stage_shapes" jsonb,
	"layout_version" integer DEFAULT 0 NOT NULL,
	"version_seq" integer DEFAULT 0 NOT NULL,
	"published_version" integer,
	"pending_layout" jsonb,
	"published" boolean DEFAULT false NOT NULL,
	CONSTRAINT "venue_id_promoter_uq" UNIQUE("id","promoter_id"),
	CONSTRAINT "venue_kind_check" CHECK ("venue"."kind" in ('TEMPLATE', 'LAYOUT')),
	CONSTRAINT "venue_owner_check" CHECK (("venue"."kind" = 'LAYOUT') = ("venue"."promoter_id" is not null) and ("venue"."kind" = 'LAYOUT' or "venue"."template_venue_id" is null)),
	CONSTRAINT "venue_version_check" CHECK ("venue"."layout_version" >= 0 and "venue"."version_seq" >= "venue"."layout_version"),
	CONSTRAINT "venue_published_check" CHECK ("venue"."published_version" is null or "venue"."published_version" = "venue"."layout_version"),
	CONSTRAINT "venue_canvas_check" CHECK (("venue"."canvas_width" is null or "venue"."canvas_width" between 1 and 100000) and ("venue"."canvas_height" is null or "venue"."canvas_height" between 1 and 100000))
);
--> statement-breakpoint
ALTER TABLE "price_tier" ADD CONSTRAINT "price_tier_venue_promoter_fk" FOREIGN KEY ("venue_id","promoter_id") REFERENCES "public"."venue"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_section_fk" FOREIGN KEY ("venue_id","section_key") REFERENCES "public"."section"("venue_id","section_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_venue_promoter_fk" FOREIGN KEY ("venue_id","promoter_id") REFERENCES "public"."venue"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_venue_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_venue_promoter_fk" FOREIGN KEY ("venue_id","promoter_id") REFERENCES "public"."venue"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue" ADD CONSTRAINT "venue_promoter_id_promoter_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."promoter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue" ADD CONSTRAINT "venue_template_fk" FOREIGN KEY ("template_venue_id") REFERENCES "public"."venue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_venue_promoter_fk" FOREIGN KEY ("venue_id","promoter_id") REFERENCES "public"."venue"("id","promoter_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- 팬·관제 경로는 공연 상세의 가격 등급만 읽는다(필요한 칸만, 추천 적용 2026-11-10 리뷰 S5). 0004의 기본 권한이 새 표에 준 읽기를 거둔다
REVOKE ALL ON venue, section, seat, price_tier FROM core_app;
--> statement-breakpoint
GRANT SELECT (venue_id, tier_id, promoter_id, name, price, display_order) ON price_tier TO core_app;
--> statement-breakpoint
-- 파트너 경로: 배치본 행 만들기와 판·게시 판·대기 판·캔버스·무대 칸 고치기, 구역·좌석·가격 등급 행 바꿔 넣기, 회차의 배치본 칸만이다.
-- 종류·판매자·틀 공개 표시는 고치지 못한다
GRANT SELECT, INSERT ON venue TO core_partner;
--> statement-breakpoint
GRANT UPDATE (canvas_width, canvas_height, stage_shapes, layout_version, version_seq, published_version, pending_layout, template_venue_id) ON venue TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON section, seat, price_tier TO core_partner;
--> statement-breakpoint
GRANT UPDATE (venue_id) ON event TO core_partner;
--> statement-breakpoint
ALTER TABLE venue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE section ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE seat ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE price_tier ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 배치본은 자기 테넌트 행만이다. 공개된 틀(TEMPLATE)은 모든 파트너가 읽기만 한다(쓰기 정책은 테넌트 행만, catalog-review 8.4.1)
CREATE POLICY venue_partner_read ON venue FOR SELECT TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid OR (kind = 'TEMPLATE' AND published));
--> statement-breakpoint
CREATE POLICY venue_partner_insert ON venue FOR INSERT TO core_partner
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY venue_partner_update ON venue FOR UPDATE TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- 틀의 구역(promoter_id NULL)은 공개된 틀의 것만 읽는다
CREATE POLICY section_partner_read ON section FOR SELECT TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (promoter_id IS NULL AND EXISTS (SELECT 1 FROM venue v WHERE v.id = section.venue_id AND v.kind = 'TEMPLATE' AND v.published)));
--> statement-breakpoint
CREATE POLICY section_partner_insert ON section FOR INSERT TO core_partner
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY section_partner_delete ON section FOR DELETE TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY seat_partner_tenant ON seat FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY price_tier_partner_tenant ON price_tier FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY price_tier_app_read ON price_tier FOR SELECT TO core_app USING (true);
--> statement-breakpoint
-- 배치본의 틀(template_venue_id)은 공개된 TEMPLATE 행만 가리킨다(앱 검사의 2차 방어, 추천 적용 2026-11-10 리뷰 S3).
-- 부른 사용자의 권한으로 돌아 행 보안을 따른다(파트너는 공개된 틀과 자기 배치본만 본다). 값이 바뀔 때만 본다(틀을 나중에 숨겨도 이미 만든 배치본은 저장된다)
CREATE FUNCTION venue_template_check() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.template_venue_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.venue t WHERE t.id = NEW.template_venue_id AND t.kind = 'TEMPLATE' AND t.published
  ) THEN
    RAISE EXCEPTION '배치본의 틀은 공개된 TEMPLATE 행이어야 한다' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER venue_template_insert_check BEFORE INSERT ON venue FOR EACH ROW WHEN (NEW.template_venue_id IS NOT NULL) EXECUTE FUNCTION venue_template_check();
--> statement-breakpoint
CREATE TRIGGER venue_template_update_check BEFORE UPDATE OF template_venue_id ON venue FOR EACH ROW WHEN (NEW.template_venue_id IS DISTINCT FROM OLD.template_venue_id) EXECUTE FUNCTION venue_template_check();
