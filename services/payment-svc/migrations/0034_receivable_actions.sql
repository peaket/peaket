CREATE TABLE "receivable_action" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"receivable_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"remaining_after" bigint NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "receivable_action_kind_check" CHECK ("receivable_action"."kind" in ('BILLED', 'COLLECTED', 'WRITE_OFF')),
	CONSTRAINT "receivable_action_amount_check" CHECK ("receivable_action"."amount" >= 0 and "receivable_action"."remaining_after" >= 0),
	CONSTRAINT "receivable_action_reason_check" CHECK (char_length("receivable_action"."reason") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "receivable_movement" ALTER COLUMN "statement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receivable_action" ADD CONSTRAINT "receivable_action_receivable_id_partner_receivable_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."partner_receivable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receivable_action_key_uidx" ON "receivable_action" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "receivable_action_receivable_idx" ON "receivable_action" USING btree ("receivable_id","created_at");