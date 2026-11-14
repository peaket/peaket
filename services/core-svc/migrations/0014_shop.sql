-- shop 상품·재고(BUILD_ORDER BAT-610 서버 잔여, docs/data.md product·product_stock, ADR-0101).
-- 상품 정의는 core 논리 DB에 있고, 파트너 경로는 core_partner 역할로 자기 테넌트 행만 본다.
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"price" integer NOT NULL,
	"shipping_fee" integer,
	"return_shipping_fee" integer,
	"return_address" text,
	"limited_qty" integer,
	"transferable" boolean DEFAULT false NOT NULL,
	"ticket_linked" boolean DEFAULT false NOT NULL,
	"linked_event_id" uuid,
	"fulfillments" text[] NOT NULL,
	"sale_starts_at" timestamp with time zone,
	"sale_ends_at" timestamp with time zone,
	"commission_rate_bp" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_status_check" CHECK ("product"."status" in ('DRAFT', 'PUBLISHED', 'HIDDEN')),
	CONSTRAINT "product_price_check" CHECK ("product"."price" >= 0),
	CONSTRAINT "product_ticket_link_check" CHECK ("product"."ticket_linked" = ("product"."linked_event_id" is not null)),
	CONSTRAINT "product_fulfillments_check" CHECK (cardinality("product"."fulfillments") > 0),
	CONSTRAINT "product_version_check" CHECK ("product"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "product_stock" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"stock" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_stock_stock_check" CHECK ("product_stock"."stock" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_stock" ADD CONSTRAINT "product_stock_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "product_promoter_updated_idx" ON "product" USING btree ("promoter_id","updated_at","id");
--> statement-breakpoint
CREATE INDEX "product_linked_event_idx" ON "product" USING btree ("linked_event_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON product TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON product_stock TO core_partner;
--> statement-breakpoint
ALTER TABLE product ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE product_stock ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY product_partner_tenant ON product FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY product_stock_partner_tenant ON product_stock FOR ALL TO core_partner
  USING (EXISTS (SELECT 1 FROM product p WHERE p.id = product_stock.product_id))
  WITH CHECK (EXISTS (SELECT 1 FROM product p WHERE p.id = product_stock.product_id));
--> statement-breakpoint
CREATE POLICY product_app_read ON product FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY product_stock_app_read ON product_stock FOR SELECT TO core_app USING (true);
