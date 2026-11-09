-- 일일 대사의 표와 인덱스(docs/data.md §4 대사, docs/features/payment.md §8, BUILD_ORDER HOT-153). payment 표는 아직 배포된 적이 없어 인덱스를 CONCURRENTLY로 만들지 않는다.
CREATE TABLE "reconciliation_diff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"pg" text NOT NULL,
	"order_ref" text NOT NULL,
	"payment_ref" text NOT NULL,
	"kind" text NOT NULL,
	"ledger_status" text,
	"pg_status" text,
	"ledger_amount" integer,
	"pg_amount" integer,
	"state" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reconciliation_diff_pg_check" CHECK ("reconciliation_diff"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "reconciliation_diff_kind_check" CHECK ("reconciliation_diff"."kind" IN ('PG_APPROVED_NO_LEDGER', 'PG_MISMATCH', 'AMOUNT_MISMATCH', 'ORDER_MISMATCH', 'LEDGER_APPROVED_PG_NOT_PAID', 'LEDGER_APPROVED_NO_PG_RECORD', 'LEDGER_FAILED_PG_APPROVED', 'PARTIAL_CANCELED_AT_PG', 'LEDGER_CANCELED_PG_APPROVED', 'UNKNOWN_HANDED_OFF', 'UNKNOWN_CANCELED_CLOSED', 'UNREADABLE')),
	CONSTRAINT "reconciliation_diff_state_check" CHECK ("reconciliation_diff"."state" IN ('OPEN', 'HANDED_OFF', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pg" text NOT NULL,
	"recon_date" date NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"pg_cursor" text,
	"compare_after" text,
	"ledger_after_at" timestamp with time zone,
	"ledger_after_id" uuid,
	"listed_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"mismatch_count" integer DEFAULT 0 NOT NULL,
	"owner" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "reconciliation_run_pg_check" CHECK ("reconciliation_run"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "reconciliation_run_status_check" CHECK ("reconciliation_run"."status" IN ('RUNNING', 'DONE', 'FAILED')),
	CONSTRAINT "reconciliation_run_stage_check" CHECK ("reconciliation_run"."stage" IN ('LISTING', 'COMPARING', 'LEDGER', 'PULLING'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_seen" (
	"run_id" uuid NOT NULL,
	"payment_ref" text NOT NULL,
	"order_ref" text NOT NULL,
	"pg_status" text NOT NULL,
	"amount" integer NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reconciliation_seen_run_id_payment_ref_pk" PRIMARY KEY("run_id","payment_ref")
);
--> statement-breakpoint
ALTER TABLE "reconciliation_diff" ADD CONSTRAINT "reconciliation_diff_run_id_reconciliation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_diff_pg_ref_kind_key" ON "reconciliation_diff" USING btree ("pg","payment_ref","kind");--> statement-breakpoint
CREATE INDEX "reconciliation_diff_run_idx" ON "reconciliation_diff" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_run_pg_date_key" ON "reconciliation_run" USING btree ("pg","recon_date");--> statement-breakpoint
CREATE INDEX "payment_recon_approved_idx" ON "payment" USING btree ("pg","approved_at","id") WHERE "payment"."status" = 'APPROVED';--> statement-breakpoint
CREATE INDEX "payment_deposit_hash_idx" ON "payment" USING btree ("approved_at") WHERE "payment"."deposit_secret_hash" IS NOT NULL;