-- catalog 모듈의 공연(회차 묶음)·공연장·아티스트·다른 이름·회차·판매자와 보류·통계 스냅샷 표(drizzle-kit generate, docs/data.md ②, ADR-0093, BUILD_ORDER HOT-170 ①).
CREATE TABLE "artist" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"promoter_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"open_at" timestamp with time zone NOT NULL,
	"entry_opens_at" timestamp with time zone,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"entry_closed_at" timestamp with time zone,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	CONSTRAINT "event_status_check" CHECK ("event"."status" in ('SCHEDULED', 'CANCELLED', 'POSTPONED')),
	CONSTRAINT "event_times_check" CHECK ("event"."open_at" < "event"."starts_at" and "event"."starts_at" < "event"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "held_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"partition" integer NOT NULL,
	"kafka_offset" bigint NOT NULL,
	"event_key" text,
	"business_key" text NOT NULL,
	"error" text NOT NULL,
	"msg_key" text,
	"record_at" timestamp with time zone NOT NULL,
	"value" "bytea",
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"reprocessed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "place" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"region" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "place_status_check" CHECK ("place"."status" in ('ACTIVE', 'CLOSED'))
);
--> statement-breakpoint
CREATE TABLE "production" (
	"id" uuid PRIMARY KEY NOT NULL,
	"promoter_id" uuid NOT NULL,
	"place_id" uuid NOT NULL,
	"title" text NOT NULL,
	"genre" text NOT NULL,
	"age_rating" text,
	"running_minutes" integer,
	"description" text,
	"sale_review" text DEFAULT 'DRAFT' NOT NULL,
	"sale_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_id_promoter_uq" UNIQUE("id","promoter_id"),
	CONSTRAINT "production_title_check" CHECK (char_length("production"."title") between 1 and 100),
	CONSTRAINT "production_genre_check" CHECK ("production"."genre" in ('콘서트', '뮤지컬', '연극', '클래식', '페스티벌', '팬미팅', '기타')),
	CONSTRAINT "production_sale_review_check" CHECK ("production"."sale_review" in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED')),
	CONSTRAINT "production_sale_approved_check" CHECK (("production"."sale_review" <> 'DRAFT' or "production"."sale_approved_at" is null) and ("production"."sale_review" <> 'APPROVED' or "production"."sale_approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "production_artist" (
	"production_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "production_artist_production_id_artist_id_pk" PRIMARY KEY("production_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "promoter" (
	"id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"representative" text,
	"address" text,
	"phone" text,
	"email" text,
	"business_reg_no" text,
	"mail_order_report_no" text,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "search_alias" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"source" text NOT NULL,
	"created_by" uuid NOT NULL,
	"reason" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "search_alias_kind_check" CHECK ("search_alias"."target_kind" in ('PRODUCTION', 'ARTIST', 'PLACE')),
	CONSTRAINT "search_alias_source_check" CHECK ("search_alias"."source" in ('PARTNER', 'OPERATOR')),
	CONSTRAINT "search_alias_alias_check" CHECK (char_length("search_alias"."alias") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "stat_snapshot" (
	"taken_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"relname" text NOT NULL,
	"indexrelname" text DEFAULT '' NOT NULL,
	"seq_scan" bigint,
	"seq_tup_read" bigint,
	"idx_scan" bigint,
	"n_live_tup" bigint,
	"n_dead_tup" bigint,
	"n_tup_upd" bigint,
	"n_tup_hot_upd" bigint,
	"total_bytes" bigint,
	CONSTRAINT "stat_snapshot_pkey" PRIMARY KEY("taken_at","kind","relname","indexrelname")
);
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_production_promoter_fk" FOREIGN KEY ("production_id","promoter_id") REFERENCES "public"."production"("id","promoter_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_promoter_id_promoter_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."promoter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production" ADD CONSTRAINT "production_place_id_place_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."place"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_artist" ADD CONSTRAINT "production_artist_production_id_production_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."production"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_artist" ADD CONSTRAINT "production_artist_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_production_idx" ON "event" USING btree ("production_id");--> statement-breakpoint
CREATE UNIQUE INDEX "held_event_position_key" ON "held_event" USING btree ("topic","partition","kafka_offset");--> statement-breakpoint
CREATE UNIQUE INDEX "held_event_event_key" ON "held_event" USING btree ("topic","event_key") WHERE event_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "held_event_pending_idx" ON "held_event" USING btree ("topic","business_key","partition","kafka_offset") WHERE reprocessed_at IS NULL;--> statement-breakpoint
CREATE INDEX "production_promoter_idx" ON "production" USING btree ("promoter_id");--> statement-breakpoint
CREATE INDEX "production_place_idx" ON "production" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "production_artist_artist_idx" ON "production_artist" USING btree ("artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_alias_live_uq" ON "search_alias" USING btree ("target_kind","target_id","alias") WHERE "search_alias"."removed_at" is null;