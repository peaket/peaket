CREATE TABLE "attendee_export" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"actor_display_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"reason" text NOT NULL,
	"format" text NOT NULL,
	"count" integer NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "attendee_export_format_check" CHECK ("attendee_export"."format" in ('CSV', 'XLSX', 'PDF')),
	CONSTRAINT "attendee_export_result_check" CHECK ("attendee_export"."result" in ('COMPLETED', 'FAILED')),
	CONSTRAINT "attendee_export_count_check" CHECK ("attendee_export"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "merch_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"event_id" uuid,
	"buyer_name" text NOT NULL,
	"buyer_phone" text NOT NULL,
	"status" text DEFAULT 'PAID' NOT NULL,
	"pg" text NOT NULL,
	"pg_store" text NOT NULL,
	"shipping_fee" integer DEFAULT 0 NOT NULL,
	"purchase_confirmed_at" timestamp with time zone,
	"ordered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merch_order_status_check" CHECK ("merch_order"."status" in ('PENDING', 'PAID', 'CANCELLED', 'REFUNDED')),
	CONSTRAINT "merch_order_pg_check" CHECK ("merch_order"."pg" in ('TOSS', 'PORTONE')),
	CONSTRAINT "merch_order_pg_store_check" CHECK ("merch_order"."pg_store" in ('STANDARD', 'ESCROW')),
	CONSTRAINT "merch_order_shipping_fee_check" CHECK ("merch_order"."shipping_fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "merch_order_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"event_id" uuid,
	"product_id" uuid NOT NULL,
	"product_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_amount" integer NOT NULL,
	"commission_rate_bp" integer NOT NULL,
	"status" text DEFAULT 'READY' NOT NULL,
	"fulfillment" text NOT NULL,
	"seat_label" text,
	"ticket_linked" boolean DEFAULT false NOT NULL,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"return_requested_at" timestamp with time zone,
	"return_resolved_at" timestamp with time zone,
	"refunded_amount" integer DEFAULT 0 NOT NULL,
	"event_ends_at" timestamp with time zone,
	CONSTRAINT "merch_order_item_status_check" CHECK ("merch_order_item"."status" in ('READY', 'SHIPPED', 'DELIVERED', 'PICKED_UP', 'LOCKED', 'RETURN_REQUESTED', 'RETURN_RECEIVED', 'DISPUTED', 'CANCELLED', 'REFUNDED')),
	CONSTRAINT "merch_order_item_fulfillment_check" CHECK ("merch_order_item"."fulfillment" in ('DELIVERY', 'PICKUP', 'WALLET')),
	CONSTRAINT "merch_order_item_quantity_check" CHECK ("merch_order_item"."quantity" > 0),
	CONSTRAINT "merch_order_item_amount_check" CHECK ("merch_order_item"."unit_amount" >= 0 and "merch_order_item"."refunded_amount" >= 0),
	CONSTRAINT "merch_order_item_commission_check" CHECK ("merch_order_item"."commission_rate_bp" >= 0 and "merch_order_item"."commission_rate_bp" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "merch_order_item" ADD CONSTRAINT "merch_order_item_order_id_merch_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."merch_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendee_export_promoter_event_idx" ON "attendee_export" USING btree ("promoter_id","event_id","created_at");--> statement-breakpoint
CREATE INDEX "merch_order_promoter_event_idx" ON "merch_order" USING btree ("promoter_id","event_id","ordered_at");--> statement-breakpoint
CREATE INDEX "merch_order_item_promoter_event_idx" ON "merch_order_item" USING btree ("promoter_id","event_id");--> statement-breakpoint
CREATE INDEX "merch_order_item_order_idx" ON "merch_order_item" USING btree ("order_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON merch_order, merch_order_item TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON attendee_export TO core_partner;
--> statement-breakpoint
GRANT INSERT, UPDATE ON merch_order, merch_order_item TO core_app;
--> statement-breakpoint
GRANT INSERT, UPDATE ON webhook_delivery TO core_app;
--> statement-breakpoint
GRANT UPDATE ON webhook_endpoint TO core_app;
--> statement-breakpoint
ALTER TABLE merch_order ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE merch_order_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attendee_export ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY merch_order_partner_tenant ON merch_order FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY merch_order_item_partner_tenant ON merch_order_item FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY attendee_export_partner_tenant ON attendee_export FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY merch_order_app_all ON merch_order FOR ALL TO core_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY merch_order_item_app_all ON merch_order_item FOR ALL TO core_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY attendee_export_app_read ON attendee_export FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY webhook_delivery_app_all ON webhook_delivery FOR ALL TO core_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY webhook_endpoint_app_write ON webhook_endpoint FOR UPDATE TO core_app USING (true) WITH CHECK (true);
