-- 예매 취소 한 건(docs/data.md order_cancellation, POL-032·POL-038, GAT-080).
-- (order_id, ticket_id) 진행 중 취소 1건 유일(VOIDED 제외). 같은 취소 ID의 재요청은 처음 결과를 그대로 돌려준다.
CREATE TABLE "order_cancellation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "order_id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "event_cancellation_request_id" uuid,
  "fraud_case_id" uuid,
  "reason" text NOT NULL,
  "approval_id" uuid,
  "days_before" integer NOT NULL,
  "within_24h" boolean NOT NULL,
  "deduction_bp" integer NOT NULL,
  "deduction_amount" integer NOT NULL,
  "refund_amount" integer NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "status_changed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "order_cancellation_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "purchase_order"("id") ON DELETE no action ON UPDATE no action,
  CONSTRAINT "order_cancellation_reason_check" CHECK ("order_cancellation"."reason" in ('USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', 'FRAUD')),
  CONSTRAINT "order_cancellation_status_check" CHECK ("order_cancellation"."status" in ('REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED')),
  CONSTRAINT "order_cancellation_amounts_check" CHECK ("order_cancellation"."days_before" >= 0 and "order_cancellation"."deduction_bp" between 0 and 10000 and "order_cancellation"."deduction_amount" >= 0 and "order_cancellation"."refund_amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "order_cancellation_active_key" ON "order_cancellation" USING btree ("order_id","ticket_id") WHERE "order_cancellation"."status" <> 'VOIDED';
--> statement-breakpoint
CREATE INDEX "order_cancellation_status_idx" ON "order_cancellation" USING btree ("status","created_at");
