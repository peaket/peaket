CREATE TABLE "sale_control" (
	"scope" text NOT NULL,
	"event_id" uuid,
	"paused" boolean DEFAULT false NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"command_id" uuid,
	"suspension_ref" text,
	"reason" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sale_control_scope_check" CHECK ("sale_control"."scope" in ('EVENT', 'PLATFORM')),
	CONSTRAINT "sale_control_event_check" CHECK (("sale_control"."scope" = 'EVENT') = ("sale_control"."event_id" is not null)),
	CONSTRAINT "sale_control_revision_check" CHECK ("sale_control"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_control_event_key" ON "sale_control" USING btree ("event_id") WHERE "sale_control"."scope" = 'EVENT';--> statement-breakpoint
CREATE UNIQUE INDEX "sale_control_platform_key" ON "sale_control" USING btree ("scope") WHERE "sale_control"."scope" = 'PLATFORM';