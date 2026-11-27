-- F-07-12 RV-02: 회차 판매 상태 사본(event_sale_state)을 만들고 search_document가 ALL_HELD를 담게 한다.
-- purchase-svc event_sale의 값은 trade.seats EventSaleChanged로 온다. core는 그 사건을 SECURITY DEFINER 함수
-- search_apply_event_sale로 이 표에 쓰고, 원천 함수 search_document_source_at이 사본을 먼저 읽는다.
-- 사본이 없는 회차는 지금처럼 open_at·starts_at - 24h로 계산한다(배포 전 행·UPCOMING·ENDED의 대체).
-- 백필은 없다: core에 과거 purchase event_sale 값이 없고, purchase-svc가 ON_SALE·ALL_HELD·SOLD_OUT 회차의
-- 같은 판을 5초 [가정]마다 다시 내므로 배포 뒤 첫 다시 내기가 사본을 채운다(ADR-0219 결정 5, F-07-12-rv02 계획 §3).
--> statement-breakpoint
CREATE TABLE "event_sale_state" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"production_id" uuid NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_sale_state_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE cascade,
	CONSTRAINT "event_sale_state_status_check" CHECK ("event_sale_state"."status" in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED')),
	CONSTRAINT "event_sale_state_version_check" CHECK ("event_sale_state"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "event_sale_state_production_idx" ON "event_sale_state" USING btree ("production_id");
--> statement-breakpoint
-- 공개 카드는 네 값만 받지만 DB 사본은 내부적으로 ALL_HELD를 담는다. 읽는 층(search-rows)이 ON_SALE로 접는다
ALTER TABLE "search_document" DROP CONSTRAINT "search_document_sale_status_check";
--> statement-breakpoint
ALTER TABLE "search_document" ADD CONSTRAINT "search_document_sale_status_check" CHECK ("sale_status" in ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED'));
--> statement-breakpoint
-- 원천 함수: 회차의 사본 상태를 먼저 쓰고, 사본이 없으면 시간으로 계산한다. 공연 합성은
-- ON_SALE → ALL_HELD → UPCOMING → SOLD_OUT → ENDED 차례다(카드 계약은 ALL_HELD를 ON_SALE로 접는다).
CREATE OR REPLACE FUNCTION search_document_source_at(p_at timestamptz, p_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  production_id uuid,
  representative_event_id uuid,
  title text,
  genre text,
  place_id uuid,
  place_name text,
  artist_ids jsonb,
  artists jsonb,
  aliases text[],
  alias_terms jsonb,
  period_start date,
  period_end date,
  next_open_at timestamptz,
  next_open_event_id uuid,
  sale_status text,
  sale_ends_at timestamptz,
  min_price integer,
  interest integer,
  poster_image_id uuid,
  poster_alt text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
SELECT
  p."id",
  (SELECT r."id" FROM (
     SELECT e2."id", e2."open_at", e2."starts_at",
       CASE
         WHEN e2."open_at" <= p_at AND e2."starts_at" - interval '24 hours' > p_at THEN 0
         WHEN e2."open_at" > p_at THEN 1
         WHEN e2."starts_at" <= p_at THEN 2
         ELSE 3 END AS grp
     FROM "event" e2
     WHERE e2."production_id" = p."id" AND e2."status" <> 'CANCELLED') r
   ORDER BY r.grp,
     CASE r.grp WHEN 0 THEN r."starts_at" WHEN 1 THEN r."open_at" WHEN 3 THEN r."starts_at" END ASC,
     CASE r.grp WHEN 2 THEN r."starts_at" END DESC,
     r."id"
   LIMIT 1),
  p."title"::text,
  p."genre"::text,
  p."place_id",
  pl."name"::text,
  COALESCE(jsonb_agg(DISTINCT a."id"::text) FILTER (WHERE a."id" IS NOT NULL), '[]'::jsonb),
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('artistId', a."id", 'name', a."name")) FILTER (WHERE a."id" IS NOT NULL), '[]'::jsonb),
  COALESCE(array_agg(DISTINCT sa."alias"::text) FILTER (WHERE sa."alias" IS NOT NULL), ARRAY[]::text[]),
  COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', sa."id", 'alias', sa."alias")) FILTER (WHERE sa."id" IS NOT NULL), '[]'::jsonb),
  MIN(e."starts_at" AT TIME ZONE 'Asia/Seoul')::date,
  MAX(e."ends_at" AT TIME ZONE 'Asia/Seoul')::date,
  MIN(e."open_at") FILTER (WHERE e."open_at" > p_at),
  (SELECT e3."id" FROM "event" e3
   WHERE e3."production_id" = p."id" AND e3."status" <> 'CANCELLED' AND e3."open_at" > p_at
   ORDER BY e3."open_at", e3."id" LIMIT 1),
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "event" e4
      LEFT JOIN "event_sale_state" s4 ON s4."event_id" = e4."id"
      WHERE e4."production_id" = p."id" AND e4."status" <> 'CANCELLED'
        AND COALESCE(s4."status",
          CASE WHEN e4."open_at" <= p_at AND e4."starts_at" - interval '24 hours' > p_at THEN 'ON_SALE'
               WHEN e4."open_at" > p_at THEN 'UPCOMING'
               ELSE 'ENDED' END) = 'ON_SALE') THEN 'ON_SALE'
    WHEN EXISTS (
      SELECT 1 FROM "event" e5
      LEFT JOIN "event_sale_state" s5 ON s5."event_id" = e5."id"
      WHERE e5."production_id" = p."id" AND e5."status" <> 'CANCELLED'
        AND COALESCE(s5."status",
          CASE WHEN e5."open_at" <= p_at AND e5."starts_at" - interval '24 hours' > p_at THEN 'ON_SALE'
               WHEN e5."open_at" > p_at THEN 'UPCOMING'
               ELSE 'ENDED' END) = 'ALL_HELD') THEN 'ALL_HELD'
    WHEN EXISTS (
      SELECT 1 FROM "event" e6
      LEFT JOIN "event_sale_state" s6 ON s6."event_id" = e6."id"
      WHERE e6."production_id" = p."id" AND e6."status" <> 'CANCELLED'
        AND COALESCE(s6."status",
          CASE WHEN e6."open_at" <= p_at AND e6."starts_at" - interval '24 hours' > p_at THEN 'ON_SALE'
               WHEN e6."open_at" > p_at THEN 'UPCOMING'
               ELSE 'ENDED' END) = 'UPCOMING') THEN 'UPCOMING'
    WHEN EXISTS (
      SELECT 1 FROM "event" e7
      LEFT JOIN "event_sale_state" s7 ON s7."event_id" = e7."id"
      WHERE e7."production_id" = p."id" AND e7."status" <> 'CANCELLED'
        AND COALESCE(s7."status",
          CASE WHEN e7."open_at" <= p_at AND e7."starts_at" - interval '24 hours' > p_at THEN 'ON_SALE'
               WHEN e7."open_at" > p_at THEN 'UPCOMING'
               ELSE 'ENDED' END) = 'SOLD_OUT') THEN 'SOLD_OUT'
    ELSE 'ENDED' END,
  MAX(e."starts_at") - interval '24 hours',
  NULL::integer,
  (SELECT count(*)::integer FROM "wish" w WHERE w."production_id" = p."id"),
  (SELECT pi."id" FROM "production_image" pi
   WHERE pi."production_id" = p."id" AND pi."kind" = 'POSTER'
   ORDER BY pi."display_order", pi."id" LIMIT 1),
  (SELECT pi."alt"::text FROM "production_image" pi
   WHERE pi."production_id" = p."id" AND pi."kind" = 'POSTER'
   ORDER BY pi."display_order", pi."id" LIMIT 1)
FROM "production" p
LEFT JOIN "place" pl ON pl."id" = p."place_id"
LEFT JOIN "production_artist" pa ON pa."production_id" = p."id"
LEFT JOIN "artist" a ON a."id" = pa."artist_id"
LEFT JOIN "search_alias" sa ON sa."target_kind" = 'PRODUCTION' AND sa."target_id" = p."id" AND sa."removed_at" IS NULL
LEFT JOIN "event" e ON e."production_id" = p."id" AND e."status" <> 'CANCELLED'
WHERE p."sale_approved_at" IS NOT NULL AND p."sale_review" <> 'SUSPENDED'
  AND (p_ids IS NULL OR p."id" = ANY (p_ids))
GROUP BY p."id", p."title", p."genre", p."place_id", pl."name"
HAVING count(e."id") > 0
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "search_document_source_at"(timestamptz, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "search_document_source_at"(timestamptz, uuid[]) TO core_app, core_ops;
--> statement-breakpoint
-- 판매 상태 사건 적용: 판 번호가 클 때만 사본을 쓰고, 공개된(search_document 줄이 있는) 공연의 합성 값과 판을 함께 고친다.
-- 한 트랜잭션이라 사본과 검색 읽기 모델이 갈라지지 않는다. core_app은 이 함수만 실행하고 표는 읽기만 한다.
CREATE OR REPLACE FUNCTION "search_apply_event_sale"(p_event_id uuid, p_status text, p_version integer, p_changed_at timestamptz)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_production_id uuid;
  v_rows bigint;
  v_version bigint;
BEGIN
  IF p_status NOT IN ('UPCOMING', 'ON_SALE', 'ALL_HELD', 'SOLD_OUT', 'ENDED') THEN
    RAISE EXCEPTION '회차 판매 상태가 다섯 값 밖이다: %', p_status USING ERRCODE = '22023';
  END IF;
  IF p_version < 1 THEN
    RAISE EXCEPTION '회차 판매 상태 판 번호는 1 이상이어야 한다: %', p_version USING ERRCODE = '22023';
  END IF;
  SELECT e."production_id" INTO v_production_id FROM "event" e WHERE e."id" = p_event_id;
  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;
  INSERT INTO "event_sale_state" ("event_id", "production_id", "status", "version", "changed_at", "updated_at")
  VALUES (p_event_id, v_production_id, p_status, p_version, p_changed_at, now())
  ON CONFLICT ("event_id") DO UPDATE
    SET "status" = excluded."status",
        "version" = excluded."version",
        "changed_at" = excluded."changed_at",
        "updated_at" = now()
    WHERE "event_sale_state"."version" < excluded."version";
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'stale';
  END IF;
  IF EXISTS (SELECT 1 FROM "search_document" d WHERE d."production_id" = v_production_id) THEN
    UPDATE "search_version" SET "version" = "version" + 1, "updated_at" = now() WHERE "id" = 1 RETURNING "version" INTO v_version;
    UPDATE "search_document" d
       SET "sale_status" = s."sale_status",
           "updated_version" = v_version
      FROM "search_document_source_at"(now(), ARRAY[v_production_id]) s
     WHERE d."production_id" = v_production_id AND s."production_id" = d."production_id";
  END IF;
  RETURN 'applied';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "search_apply_event_sale"(uuid, text, integer, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "search_apply_event_sale"(uuid, text, integer, timestamp with time zone) TO core_app;
--> statement-breakpoint
GRANT SELECT ON "event_sale_state" TO core_app;
