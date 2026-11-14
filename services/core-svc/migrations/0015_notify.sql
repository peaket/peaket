CREATE TABLE "webhook_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"webhook_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_http_status" integer,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "webhook_delivery_endpoint_event_uq" UNIQUE("endpoint_id","webhook_id"),
	CONSTRAINT "webhook_delivery_status_check" CHECK ("webhook_delivery"."status" in ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"url" text NOT NULL,
	"event_types" text[] NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"disabled_reason" text,
	"secret" text NOT NULL,
	"previous_secret" text,
	"secret_issued_at" timestamp with time zone NOT NULL,
	"previous_secret_valid_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "webhook_endpoint_status_check" CHECK ("webhook_endpoint"."status" in ('ACTIVE', 'DISABLED')),
	CONSTRAINT "webhook_endpoint_disabled_reason_check" CHECK ("webhook_endpoint"."disabled_reason" is null or "webhook_endpoint"."disabled_reason" in ('PARTNER', 'FAILING'))
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_endpoint_created_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_promoter_idx" ON "webhook_endpoint" USING btree ("promoter_id","secret_issued_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON webhook_endpoint, webhook_delivery TO core_partner;
--> statement-breakpoint
ALTER TABLE webhook_endpoint ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY webhook_endpoint_partner_tenant ON webhook_endpoint FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY webhook_delivery_partner_tenant ON webhook_delivery FOR ALL TO core_partner
  USING (EXISTS (SELECT 1 FROM webhook_endpoint e WHERE e.id = webhook_delivery.endpoint_id))
  WITH CHECK (EXISTS (SELECT 1 FROM webhook_endpoint e WHERE e.id = webhook_delivery.endpoint_id));
--> statement-breakpoint
CREATE POLICY webhook_endpoint_app_read ON webhook_endpoint FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY webhook_delivery_app_read ON webhook_delivery FOR SELECT TO core_app USING (true);
