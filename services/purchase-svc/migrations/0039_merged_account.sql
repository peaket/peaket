CREATE TABLE "merged_account" (
	"absorbed_account_id" uuid PRIMARY KEY NOT NULL,
	"representative_account_id" uuid NOT NULL,
	"merge_id" uuid NOT NULL,
	"merged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "merged_account_representative_idx" ON "merged_account" USING btree ("representative_account_id");