ALTER TABLE "webhook_delivery" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "webhook_delivery" USING btree ("next_attempt_at") WHERE "status" IN ('PENDING', 'RETRYING');
