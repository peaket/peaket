CREATE TABLE "event_pg_config" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"pg_primary" text NOT NULL,
	"pg_fallback" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "event_pg_config_primary_check" CHECK ("event_pg_config"."pg_primary" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "event_pg_config_fallback_check" CHECK ("event_pg_config"."pg_fallback" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "event_pg_config_distinct_check" CHECK ("event_pg_config"."pg_fallback" IS NULL OR "event_pg_config"."pg_fallback" <> "event_pg_config"."pg_primary")
);
--> statement-breakpoint
CREATE TABLE "pg_switch" (
	"scope" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"from_pg" text,
	"to_pg" text,
	"version" bigint NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pg_switch_scope_check" CHECK ("pg_switch"."scope" = 'PLATFORM' OR "pg_switch"."scope" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "pg_switch_from_pg_check" CHECK ("pg_switch"."from_pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "pg_switch_to_pg_check" CHECK ("pg_switch"."to_pg" IN ('TOSS', 'PORTONE', 'SIMULATOR')),
	CONSTRAINT "pg_switch_version_check" CHECK ("pg_switch"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payment" ADD COLUMN "entry_opens_at" timestamp with time zone;