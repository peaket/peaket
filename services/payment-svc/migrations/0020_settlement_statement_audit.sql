CREATE TABLE "settlement_statement_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settlement_statement_audit" ADD CONSTRAINT "settlement_statement_audit_statement_id_settlement_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlement_statement_audit_statement_idx" ON "settlement_statement_audit" USING btree ("statement_id","created_at");