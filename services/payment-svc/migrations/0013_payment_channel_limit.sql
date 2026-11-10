CREATE TABLE "payment_channel_limit" (
	"pg" text NOT NULL,
	"channel" text NOT NULL,
	"ratio_percent" integer NOT NULL,
	"lowered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_channel_limit_pg_channel_pk" PRIMARY KEY("pg","channel"),
	CONSTRAINT "payment_channel_limit_pg_check" CHECK ("payment_channel_limit"."pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "payment_channel_limit_channel_check" CHECK ("payment_channel_limit"."channel" = 'ALL'),
	CONSTRAINT "payment_channel_limit_ratio_check" CHECK ("payment_channel_limit"."ratio_percent" BETWEEN 25 AND 99),
	CONSTRAINT "payment_channel_limit_expires_check" CHECK ("payment_channel_limit"."expires_at" > "payment_channel_limit"."lowered_at"),
	CONSTRAINT "payment_channel_limit_version_check" CHECK ("payment_channel_limit"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_pg_channel_observed" (
	"channel_key" text PRIMARY KEY NOT NULL,
	"pg_provider" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
