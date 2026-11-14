CREATE TABLE "partner_receivable" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"pg" text NOT NULL,
	"cause" text NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "partner_receivable_pg_check" CHECK ("partner_receivable"."pg" in ('TOSS', 'PORTONE')),
	CONSTRAINT "partner_receivable_cause_check" CHECK ("partner_receivable"."cause" in ('REFUND_AFTER_PAYOUT', 'CHARGEBACK', 'COMPENSATION_ADVANCE', 'NEGATIVE_STATEMENT')),
	CONSTRAINT "partner_receivable_status_check" CHECK ("partner_receivable"."status" in ('OPEN', 'OFFSET', 'GUARANTEE', 'BILLED', 'CLOSED', 'WRITTEN_OFF')),
	CONSTRAINT "partner_receivable_amount_check" CHECK ("partner_receivable"."amount" >= 0 and "partner_receivable"."remaining" >= 0 and "partner_receivable"."remaining" <= "partner_receivable"."amount")
);
--> statement-breakpoint
CREATE TABLE "receivable_move" (
	"receivable_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"moved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "receivable_move_receivable_id_statement_id_pk" PRIMARY KEY("receivable_id","statement_id"),
	CONSTRAINT "receivable_move_amount_check" CHECK ("receivable_move"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "receivable_move" ADD CONSTRAINT "receivable_move_receivable_id_partner_receivable_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."partner_receivable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receivable_move" ADD CONSTRAINT "receivable_move_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_receivable_open_idx" ON "partner_receivable" USING btree ("promoter_id","pg","status","created_at");