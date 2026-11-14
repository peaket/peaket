CREATE TABLE "payout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"amount" bigint NOT NULL,
	"ref_payout_id" text NOT NULL,
	"pg_payout_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"pg_transfer_id" text,
	"transfer_check" text,
	"transfer_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_status_check" CHECK ("payout"."status" in ('REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELED')),
	CONSTRAINT "payout_amount_check" CHECK ("payout"."amount" > 0),
	CONSTRAINT "payout_seq_check" CHECK ("payout"."seq" >= 1),
	CONSTRAINT "payout_transfer_check_check" CHECK ("payout"."transfer_check" is null or "payout"."transfer_check" in ('MATCHED', 'MISMATCH', 'MISSING'))
);
--> statement-breakpoint
CREATE TABLE "payout_account" (
	"promoter_id" uuid PRIMARY KEY NOT NULL,
	"bank_code" text NOT NULL,
	"account_last4" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"hold_until" timestamp with time zone NOT NULL,
	"holder_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "payout_account_version_check" CHECK ("payout_account"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payout_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pg" text NOT NULL,
	"pg_store" text NOT NULL,
	"payout_date" date NOT NULL,
	"total_amount" bigint NOT NULL,
	"statement_count" integer NOT NULL,
	"approval_id" uuid,
	"portone_bulk_payout_id" text,
	"pg_balance_krw" bigint,
	"pg_balance_source" text,
	"pg_balance_observed_at" timestamp with time zone,
	"pg_balance_observed_by" uuid,
	"pg_balance_ledger_krw" bigint,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_batch_pg_check" CHECK ("payout_batch"."pg" in ('TOSS', 'PORTONE')),
	CONSTRAINT "payout_batch_pg_store_check" CHECK ("payout_batch"."pg_store" in ('STANDARD', 'ESCROW')),
	CONSTRAINT "payout_batch_status_check" CHECK ("payout_batch"."status" in ('PREPARED', 'PENDING_APPROVAL', 'APPROVED', 'SUBMITTED', 'COMPLETED', 'PARTIAL_FAILED')),
	CONSTRAINT "payout_batch_balance_source_check" CHECK ("payout_batch"."pg_balance_source" is null or "payout_batch"."pg_balance_source" in ('PG_API', 'OPERATOR_CONSOLE')),
	CONSTRAINT "payout_batch_total_check" CHECK ("payout_batch"."total_amount" >= 0 and "payout_batch"."statement_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "seller_kyc" (
	"promoter_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"business_verified" boolean DEFAULT false NOT NULL,
	"representative_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "seller_kyc_status_check" CHECK ("seller_kyc"."status" in ('PENDING', 'VERIFIED', 'REJECTED')),
	CONSTRAINT "seller_kyc_source_check" CHECK ("seller_kyc"."source" in ('MANUAL', 'TOSS', 'PORTONE'))
);
--> statement-breakpoint
CREATE TABLE "settlement_statement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid,
	"pg" text NOT NULL,
	"pg_store" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"gross_amount" bigint NOT NULL,
	"refund_amount" bigint NOT NULL,
	"commission_amount" bigint NOT NULL,
	"commission_vat" bigint NOT NULL,
	"offset_amount" bigint DEFAULT 0 NOT NULL,
	"payout_amount" bigint NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"excluded_payments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"hold_reason" text,
	"dispute_due_at" timestamp with time zone,
	"payout_date" date,
	"payout_bank_code" text,
	"payout_account_last4" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "settlement_statement_kind_check" CHECK ("settlement_statement"."kind" in ('EVENT', 'PRODUCT')),
	CONSTRAINT "settlement_statement_pg_check" CHECK ("settlement_statement"."pg" in ('TOSS', 'PORTONE')),
	CONSTRAINT "settlement_statement_pg_store_check" CHECK ("settlement_statement"."pg_store" in ('STANDARD', 'ESCROW')),
	CONSTRAINT "settlement_statement_status_check" CHECK ("settlement_statement"."status" in ('CALCULATED', 'NOTIFIED', 'DISPUTED', 'CONFIRMED', 'HELD', 'SCHEDULED', 'FAILED', 'PAID', 'CARRIED_OVER', 'SUPERSEDED')),
	CONSTRAINT "settlement_statement_hold_reason_check" CHECK ("settlement_statement"."hold_reason" is null or "settlement_statement"."hold_reason" in ('KYC', 'ACCOUNT_CHANGE', 'BALANCE', 'ACCOUNT_MISMATCH', 'SALE_SUSPENDED')),
	CONSTRAINT "settlement_statement_amounts_check" CHECK ("settlement_statement"."gross_amount" >= 0 and "settlement_statement"."refund_amount" >= 0 and "settlement_statement"."commission_amount" >= 0 and "settlement_statement"."commission_vat" >= 0 and "settlement_statement"."offset_amount" >= 0),
	CONSTRAINT "settlement_statement_revision_check" CHECK ("settlement_statement"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "statement_dispute" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"result" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "statement_dispute_reason_check" CHECK ("statement_dispute"."reason_code" in ('GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER')),
	CONSTRAINT "statement_dispute_result_check" CHECK ("statement_dispute"."result" is null or "statement_dispute"."result" in ('ADJUSTED', 'DISMISSED'))
);
--> statement-breakpoint
CREATE TABLE "statement_source" (
	"statement_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	CONSTRAINT "statement_source_statement_id_source_id_kind_pk" PRIMARY KEY("statement_id","source_id","kind"),
	CONSTRAINT "statement_source_kind_check" CHECK ("statement_source"."kind" in ('GROSS', 'REFUND')),
	CONSTRAINT "statement_source_amount_check" CHECK ("statement_source"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_batch_id_payout_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout" ADD CONSTRAINT "payout_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_dispute" ADD CONSTRAINT "statement_dispute_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_source" ADD CONSTRAINT "statement_source_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_ref_key" ON "payout" USING btree ("ref_payout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batch_statement_seq_key" ON "payout" USING btree ("batch_id","statement_id","seq");--> statement-breakpoint
CREATE INDEX "payout_batch_idx" ON "payout" USING btree ("batch_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batch_key" ON "payout_batch" USING btree ("pg","pg_store","payout_date") WHERE "payout_batch"."status" not in ('COMPLETED', 'PARTIAL_FAILED');--> statement-breakpoint
CREATE INDEX "payout_batch_list_idx" ON "payout_batch" USING btree ("payout_date","pg","pg_store","status");--> statement-breakpoint
CREATE INDEX "settlement_statement_partner_idx" ON "settlement_statement" USING btree ("promoter_id","kind","created_at","id");--> statement-breakpoint
CREATE INDEX "settlement_statement_event_idx" ON "settlement_statement" USING btree ("promoter_id","event_id","created_at");--> statement-breakpoint
CREATE INDEX "settlement_statement_payout_idx" ON "settlement_statement" USING btree ("pg","pg_store","payout_date","status");--> statement-breakpoint
CREATE INDEX "statement_dispute_statement_idx" ON "statement_dispute" USING btree ("statement_id","submitted_at");--> statement-breakpoint
