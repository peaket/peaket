-- 검색 읽기 모델(ADR-0094, docs/features/search.md §2.2, BUILD_ORDER HOT-270·HOT-280).
-- search_document는 뷰다: production·event·place·artist·production_artist·search_alias·production_image·wish를 모아
-- 항상 지금 값을 보여 준다. search_term은 사전 확장을 위한 자리이고, search_version은 사전 판을 읽는 자리다.
CREATE TABLE "search_version" (
	"id" integer PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_version_one_check" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "search_version" ("id", "version") VALUES (1, 1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE "search_term" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"alias_of" text,
	"norm" text NOT NULL,
	"norm_nospace" text NOT NULL,
	"jamo" text NOT NULL,
	"chosung" text NOT NULL,
	"updated_version" bigint NOT NULL,
	CONSTRAINT "search_term_kind_check" CHECK ("kind" in ('PRODUCTION', 'ARTIST', 'PLACE'))
);
--> statement-breakpoint
CREATE INDEX "search_term_norm_nospace_idx" ON "search_term" USING btree ("norm_nospace" text_pattern_ops);
--> statement-breakpoint
CREATE INDEX "search_term_jamo_idx" ON "search_term" USING btree ("jamo" text_pattern_ops);
--> statement-breakpoint
CREATE INDEX "search_term_chosung_idx" ON "search_term" USING btree ("chosung" text_pattern_ops);
--> statement-breakpoint
CREATE INDEX "search_term_updated_version_idx" ON "search_term" USING btree ("updated_version");
--> statement-breakpoint
CREATE TABLE "search_removal" (
	"version" bigint NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_removal_pk" PRIMARY KEY("version","kind","target_id"),
	CONSTRAINT "search_removal_kind_check" CHECK ("kind" in ('DOCUMENT', 'TERM'))
);
--> statement-breakpoint
CREATE VIEW "search_document" AS
SELECT
	p."id" AS production_id,
	(SELECT e2."id" FROM "event" e2
	 WHERE e2."production_id" = p."id" AND e2."status" <> 'CANCELLED'
	 ORDER BY CASE
	   WHEN e2."open_at" <= now() AND e2."starts_at" - interval '24 hours' > now() THEN 0
	   WHEN e2."open_at" > now() THEN 1
	   WHEN e2."starts_at" - interval '24 hours' <= now() THEN 2
	   ELSE 3 END, e2."open_at", e2."starts_at", e2."id"
	 LIMIT 1) AS representative_event_id,
	p."title" AS title,
	p."genre" AS genre,
	p."place_id" AS place_id,
	pl."name" AS place_name,
	COALESCE(jsonb_agg(DISTINCT a."id"::text) FILTER (WHERE a."id" IS NOT NULL), '[]'::jsonb) AS artist_ids,
	COALESCE(jsonb_agg(DISTINCT jsonb_build_object('artistId', a."id", 'name', a."name")) FILTER (WHERE a."id" IS NOT NULL), '[]'::jsonb) AS artists,
	COALESCE(array_agg(DISTINCT sa."alias") FILTER (WHERE sa."alias" IS NOT NULL), ARRAY[]::text[]) AS aliases,
	MIN(e."starts_at" AT TIME ZONE 'Asia/Seoul')::date AS period_start,
	MAX(e."ends_at" AT TIME ZONE 'Asia/Seoul')::date AS period_end,
	MIN(e."open_at") FILTER (WHERE e."open_at" > now()) AS next_open_at,
	(SELECT e3."id" FROM "event" e3
	 WHERE e3."production_id" = p."id" AND e3."status" <> 'CANCELLED' AND e3."open_at" > now()
	 ORDER BY e3."open_at", e3."id" LIMIT 1) AS next_open_event_id,
	CASE
	  WHEN MIN(e."open_at") > now() THEN 'UPCOMING'
	  WHEN MAX(e."starts_at") - interval '24 hours' <= now() THEN 'ENDED'
	  ELSE 'ON_SALE' END AS sale_status,
	MAX(e."starts_at") - interval '24 hours' AS sale_ends_at,
	NULL::int AS min_price,
	(SELECT count(*)::int FROM "wish" w WHERE w."production_id" = p."id") AS interest,
	(SELECT version FROM "search_version" WHERE id = 1) AS updated_version,
	(SELECT pi."id" FROM "production_image" pi
	 WHERE pi."production_id" = p."id" AND pi."kind" = 'POSTER'
	 ORDER BY pi."display_order" LIMIT 1) AS poster_image_id,
	(SELECT pi."alt" FROM "production_image" pi
	 WHERE pi."production_id" = p."id" AND pi."kind" = 'POSTER'
	 ORDER BY pi."display_order" LIMIT 1) AS poster_alt
FROM "production" p
LEFT JOIN "place" pl ON pl."id" = p."place_id"
LEFT JOIN "production_artist" pa ON pa."production_id" = p."id"
LEFT JOIN "artist" a ON a."id" = pa."artist_id"
LEFT JOIN "search_alias" sa ON sa."target_kind" = 'PRODUCTION' AND sa."target_id" = p."id" AND sa."removed_at" IS NULL
LEFT JOIN "event" e ON e."production_id" = p."id" AND e."status" <> 'CANCELLED'
WHERE p."sale_approved_at" IS NOT NULL AND p."sale_review" <> 'SUSPENDED'
GROUP BY p."id", p."title", p."genre", p."place_id", pl."name"
HAVING count(e."id") > 0;
