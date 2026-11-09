ALTER TABLE "payment_entry_pause" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_entry_trial" ADD COLUMN "first_call_at" timestamp with time zone;