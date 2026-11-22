CREATE TABLE "statement_adjustment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"dispute_id" uuid,
	"amount" bigint NOT NULL,
	"evidence_note" text,
	"status" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "statement_adjustment_reason_check" CHECK ("statement_adjustment"."reason_code" in ('GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER', 'LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION')),
	CONSTRAINT "statement_adjustment_amount_check" CHECK ("statement_adjustment"."amount" <> 0),
	CONSTRAINT "statement_adjustment_status_check" CHECK ("statement_adjustment"."status" in ('PENDING', 'APPLIED', 'VOID')),
	CONSTRAINT "statement_adjustment_note_check" CHECK ("statement_adjustment"."evidence_note" is null or char_length("statement_adjustment"."evidence_note") <= 2000),
	CONSTRAINT "statement_adjustment_applied_check" CHECK (("statement_adjustment"."status" = 'APPLIED') = ("statement_adjustment"."applied_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "settlement_statement" ADD COLUMN "adjustment_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD COLUMN "resolved_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD COLUMN "case_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "statement_adjustment" ADD CONSTRAINT "statement_adjustment_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_adjustment" ADD CONSTRAINT "statement_adjustment_dispute_id_statement_dispute_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."statement_dispute"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_adjustment_approval_uidx" ON "statement_adjustment" USING btree ("approval_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_adjustment_pending_uidx" ON "statement_adjustment" USING btree ("statement_id") WHERE "statement_adjustment"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "statement_adjustment_statement_idx" ON "statement_adjustment" USING btree ("statement_id","requested_at");--> statement-breakpoint
CREATE INDEX "statement_dispute_case_pending_idx" ON "statement_dispute" USING btree ("submitted_at") WHERE "statement_dispute"."case_requested_at" is null and "statement_dispute"."result" is null;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD CONSTRAINT "statement_dispute_resolution_note_check" CHECK ("statement_dispute"."resolution_note" is null or char_length("statement_dispute"."resolution_note") between 1 and 2000);