CREATE TABLE "guarantee_collection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"receivable_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"guarantee_kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"basis_amount" bigint NOT NULL,
	"guarantee_rate_bp" integer NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "guarantee_collection_kind_check" CHECK ("guarantee_collection"."guarantee_kind" in ('DEPOSIT', 'PERFORMANCE_BOND')),
	CONSTRAINT "guarantee_collection_amount_check" CHECK ("guarantee_collection"."amount" > 0 and "guarantee_collection"."basis_amount" >= 0 and "guarantee_collection"."guarantee_rate_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "settlement_webhook_receipt" (
	"transmission_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receivable_move" DROP CONSTRAINT "receivable_move_receivable_id_statement_id_pk";--> statement-breakpoint
ALTER TABLE "receivable_move" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "receivable_move" ADD COLUMN "kind" text DEFAULT 'OFFSET' NOT NULL;--> statement-breakpoint
ALTER TABLE "seller_kyc" ADD COLUMN "toss_seller_id" text;--> statement-breakpoint
ALTER TABLE "seller_kyc" ADD COLUMN "toss_seller_status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "guarantee_collection" ADD CONSTRAINT "guarantee_collection_receivable_id_partner_receivable_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."partner_receivable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guarantee_collection_key_uidx" ON "guarantee_collection" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "receivable_move_receivable_idx" ON "receivable_move" USING btree ("receivable_id","moved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_kyc_toss_seller_id_uidx" ON "seller_kyc" USING btree ("toss_seller_id") WHERE "seller_kyc"."toss_seller_id" is not null;--> statement-breakpoint
ALTER TABLE "receivable_move" ADD CONSTRAINT "receivable_move_kind_check" CHECK ("receivable_move"."kind" in ('OFFSET', 'GUARANTEE', 'COLLECTED', 'WRITE_OFF', 'REVERSAL'));--> statement-breakpoint
ALTER TABLE "seller_kyc" ADD CONSTRAINT "seller_kyc_toss_seller_status_check" CHECK ("seller_kyc"."toss_seller_status" in ('PENDING', 'PARTIALLY_APPROVED', 'APPROVED', 'KYC_REQUIRED', 'REJECTED'));