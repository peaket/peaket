CREATE TABLE "payment_entry_pause" (
	"pg" text NOT NULL,
	"channel" text NOT NULL,
	"stage" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"trial_started_at" timestamp with time zone,
	"version" bigint NOT NULL,
	CONSTRAINT "payment_entry_pause_pg_channel_pk" PRIMARY KEY("pg","channel"),
	CONSTRAINT "payment_entry_pause_pg_check" CHECK ("payment_entry_pause"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "payment_entry_pause_channel_check" CHECK ("payment_entry_pause"."channel" = 'ALL'),
	CONSTRAINT "payment_entry_pause_stage_check" CHECK ("payment_entry_pause"."stage" IN ('OPEN', 'PROBING', 'TRIAL')),
	CONSTRAINT "payment_entry_pause_reason_check" CHECK ("payment_entry_pause"."reason" IN ('PG_FAILURE', 'CHANNEL_WAIT')),
	CONSTRAINT "payment_entry_pause_version_check" CHECK ("payment_entry_pause"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_entry_trial" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"pg" text NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"first_result" text,
	"first_result_at" timestamp with time zone,
	"first_call_ms" integer,
	CONSTRAINT "payment_entry_trial_pg_check" CHECK ("payment_entry_trial"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "payment_entry_trial_first_result_check" CHECK ("payment_entry_trial"."first_result" IN ('APPROVED', 'DECLINED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "payment_entry_trial_first_call_ms_check" CHECK ("payment_entry_trial"."first_call_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payment_confirm_job" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_entry_trial_pg_admitted_idx" ON "payment_entry_trial" USING btree ("pg","admitted_at");