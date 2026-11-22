CREATE TABLE "payout_batch_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"approval_id" text NOT NULL,
	"event" text NOT NULL,
	"reason" text NOT NULL,
	"requester_id" text,
	"approver_id" text,
	"amount" bigint,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_batch_audit_event_check" CHECK ("payout_batch_audit"."event" in ('APPROVED', 'REJECTED')),
	CONSTRAINT "payout_batch_audit_currency_check" CHECK ("payout_batch_audit"."currency" = 'KRW')
);
--> statement-breakpoint
ALTER TABLE "payout_batch_audit" ADD CONSTRAINT "payout_batch_audit_batch_id_payout_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_batch_audit_batch_idx" ON "payout_batch_audit" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batch_approval_uq" ON "payout_batch" USING btree ("approval_id") WHERE "payout_batch"."approval_id" is not null;