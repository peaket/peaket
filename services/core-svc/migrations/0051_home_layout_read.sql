-- 홈 배너·테마 읽기 표(core_app SELECT 전용, 쓰기·행 보안 없음, docs/data.md §2, BUILD_ORDER HOT-305).
CREATE TABLE "home_banner" (
	"id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"image_key" text NOT NULL,
	"alt_text" text NOT NULL,
	"title" text,
	"subtitle" text,
	"sort_order" integer NOT NULL,
	"display_from" timestamp with time zone NOT NULL,
	"display_until" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_theme" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer NOT NULL,
	"display_from" timestamp with time zone NOT NULL,
	"display_until" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_theme_item" (
	"theme_id" uuid NOT NULL,
	"production_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "home_theme_item_theme_id_production_id_pk" PRIMARY KEY("theme_id","production_id")
);
--> statement-breakpoint
ALTER TABLE "home_banner" ADD CONSTRAINT "home_banner_production_id_production_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."production"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "home_theme_item" ADD CONSTRAINT "home_theme_item_theme_id_home_theme_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."home_theme"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "home_theme_item" ADD CONSTRAINT "home_theme_item_production_id_production_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."production"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "home_banner_display_idx" ON "home_banner" USING btree ("display_from","display_until");
--> statement-breakpoint
CREATE INDEX "home_theme_display_idx" ON "home_theme" USING btree ("display_from","display_until");
--> statement-breakpoint
CREATE INDEX "home_theme_item_order_idx" ON "home_theme_item" USING btree ("theme_id","sort_order");
--> statement-breakpoint
GRANT SELECT ON "home_banner" TO core_app;
--> statement-breakpoint
GRANT SELECT ON "home_theme" TO core_app;
--> statement-breakpoint
GRANT SELECT ON "home_theme_item" TO core_app;
