-- COV2-02: search_document.sale_status를 메모리 cardSaleStatus와 같은 규칙으로 고친다.
-- 판매 중(open_at <= now() < starts_at - 24h)인 회차가 하나라도 있으면 ON_SALE, 없고 오픈 전 회차가 있으면 UPCOMING,
-- 남은 회차가 모두 지났으면 ENDED다. 지난 회차 + 오픈 전 다음 회차를 ON_SALE로 잘못 표시하지 않는다.
CREATE OR REPLACE VIEW "search_document" AS
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
	  WHEN EXISTS (SELECT 1 FROM "event" e4 WHERE e4."production_id" = p."id" AND e4."status" <> 'CANCELLED'
	    AND e4."open_at" <= now() AND e4."starts_at" - interval '24 hours' > now()) THEN 'ON_SALE'
	  WHEN EXISTS (SELECT 1 FROM "event" e5 WHERE e5."production_id" = p."id" AND e5."status" <> 'CANCELLED'
	    AND e5."open_at" > now()) THEN 'UPCOMING'
	  ELSE 'ENDED' END AS sale_status,
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
