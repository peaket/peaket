-- 회차 판매 설정 사본(판매 승인 LCH-080, docs/data.md `q:{event:E}:cfg`). queue-svc는 대기열 Redis를,
-- purchase-svc(BAT-051)는 이 표를 읽어 홀드 때 판매 정책을 평가한다. payload는 EventSaleConfig JSON이다.
CREATE TABLE "event_sale_config" (
  "event_id" uuid PRIMARY KEY NOT NULL,
  "production_id" uuid NOT NULL,
  "promoter_id" uuid NOT NULL,
  "rev" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "event_sale_config_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE cascade,
  CONSTRAINT "event_sale_config_rev_check" CHECK ("event_sale_config"."rev" >= 1)
);--> statement-breakpoint
CREATE INDEX "event_sale_config_production_idx" ON "event_sale_config" USING btree ("production_id");
