ALTER TABLE "purchase_order" ADD COLUMN "priority_grant_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "priority_grant_offered_seat_key" ON "priority_grant" USING btree ("event_id","seat_id") WHERE "priority_grant"."status" = 'OFFERED';--> statement-breakpoint
CREATE INDEX "priority_grant_expiry_idx" ON "priority_grant" USING btree ("expires_at") WHERE "priority_grant"."status" = 'OFFERED';