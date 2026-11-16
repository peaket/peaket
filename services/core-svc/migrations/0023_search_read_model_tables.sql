-- 검색 읽기 모델을 정본대로 표로 바꾼다(ADR-0271 결정 1·2·9, docs/features/search.md §2.2·§2.3, docs/data.md search_document, BUILD_ORDER HOT-270).
-- 1. DB 문자 분류(pg_database.datctype)가 C·POSIX면 멈춘다(SR-T7). PostgreSQL 16부터 current_setting('lc_ctype')이 없어 데이터베이스 줄을 본다.
-- 2. 0018의 계산은 시각을 받는 원천 함수 search_document_source_at(at, ids)와 그것을 now()로 부르는 원천 뷰 search_document_source로 옮긴다.
--    대표 회차는 ADR-0093 결정 8의 차례(① 판매 중 회차 가운데 판매 종료가 가장 이른 것 → ② 오픈 예정 가운데 오픈이 가장 이른 것 →
--    ④ 공연한 회차 가운데 가장 최근 것 → 그 밖은 시작이 가장 이른 것, 같으면 회차 ID가 작은 것)로 고친다(메모리 representativeEvent와 같다).
-- 3. search_document는 표다. 같은 트랜잭션의 동기화(앱의 DrizzleSearchReadModel.sync)가 원천 함수로 다시 계산해 고치고,
--    바뀐 줄의 판(updated_version)을 적는다. search_term·search_removal·search_version은 0009 그대로다.
-- 4. search_version에 따라잡기를 마친 시각 칸(reconciled_at)과 따라잡기 임대 칸 넷을 더한다.
-- 5. 판매 승인(core_ops)·포스터 게시(core_partner) 트랜잭션이 동기화를 부르므로 그 역할에 검색 표 쓰기 권한을 준다.
--    원천 함수는 소유자 권한으로 돈다(파트너 연결의 행 보안·칸 권한과 상관없이 공개 공연만 계산한다).
DO $$
DECLARE
  v_ctype text;
BEGIN
  SELECT datctype INTO v_ctype FROM pg_database WHERE datname = current_database();
  IF v_ctype IN ('C', 'POSIX') THEN
    RAISE EXCEPTION 'DB 문자 분류(lc_ctype, pg_database.datctype)가 %다. 한글 조각 비교·대소문자 처리가 틀어지므로 C·POSIX가 아닌 로케일로 DB를 만든다(docs/features/search.md §2.2, ADR-0271 결정 9)', v_ctype;
  END IF;
END
$$;
--> statement-breakpoint
DROP VIEW "search_document";
--> statement-breakpoint
CREATE FUNCTION search_document_source_at(p_at timestamptz, p_ids uuid[] DEFAULT NULL)
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
    WHEN EXISTS (SELECT 1 FROM "event" e4 WHERE e4."production_id" = p."id" AND e4."status" <> 'CANCELLED'
      AND e4."open_at" <= p_at AND e4."starts_at" - interval '24 hours' > p_at) THEN 'ON_SALE'
    WHEN EXISTS (SELECT 1 FROM "event" e5 WHERE e5."production_id" = p."id" AND e5."status" <> 'CANCELLED'
      AND e5."open_at" > p_at) THEN 'UPCOMING'
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
REVOKE ALL ON FUNCTION search_document_source_at(timestamptz, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION search_document_source_at(timestamptz, uuid[]) TO core_app, core_partner, core_ops;
--> statement-breakpoint
-- 동기화의 계산 원천(질의는 직접 읽지 않는다). 어긋남 점검이 표와 견준다
CREATE VIEW "search_document_source" AS SELECT * FROM search_document_source_at(now());
--> statement-breakpoint
CREATE TABLE "search_document" (
	"production_id" uuid PRIMARY KEY NOT NULL,
	"representative_event_id" uuid,
	"title" text NOT NULL,
	"genre" text NOT NULL,
	"place_id" uuid,
	"place_name" text,
	"artist_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artists" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aliases" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"period_start" date,
	"period_end" date,
	"next_open_at" timestamp with time zone,
	"next_open_event_id" uuid,
	"sale_status" text NOT NULL,
	"sale_ends_at" timestamp with time zone,
	"min_price" integer,
	"interest" integer DEFAULT 0 NOT NULL,
	"poster_image_id" uuid,
	"poster_alt" text,
	"updated_version" bigint NOT NULL,
	CONSTRAINT "search_document_sale_status_check" CHECK ("sale_status" in ('UPCOMING', 'ON_SALE', 'SOLD_OUT', 'ENDED'))
);
--> statement-breakpoint
CREATE INDEX "search_document_updated_version_idx" ON "search_document" USING btree ("updated_version");
--> statement-breakpoint
CREATE INDEX "search_document_place_idx" ON "search_document" USING btree ("place_id");
--> statement-breakpoint
-- 1분 정리 작업이 판매 종료(starts_at − 24시간) 시각이 지난 공연을 찾는다(오픈 시각은 0002의 event_open_at_idx)
CREATE INDEX "event_starts_at_idx" ON "event" USING btree ("starts_at");
--> statement-breakpoint
CREATE INDEX "search_removal_removed_at_idx" ON "search_removal" USING btree ("removed_at");
--> statement-breakpoint
-- 마지막으로 끝까지 마친 시작 따라잡기의 시작 시각(ADR-0271 결정 12 보탬, docs/data.md search_version.reconciled_at). 따라잡기 첫 끊음에서 비우고 마지막 끊음에서 적는다
ALTER TABLE "search_version" ADD COLUMN "reconciled_at" timestamp with time zone;
--> statement-breakpoint
-- 따라잡기 임대(ADR-0271 결정 12 '잠금과 임대', docs/data.md search_version): 주인·만료(DB now() 기준)·시작 시각·커서(마지막으로 마친 끊음의 마지막 공연 ID)
ALTER TABLE "search_version" ADD COLUMN "reconcile_owner" text, ADD COLUMN "reconcile_lease_until" timestamp with time zone, ADD COLUMN "reconcile_started_at" timestamp with time zone, ADD COLUMN "reconcile_cursor" uuid;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "search_document", "search_term" TO core_ops, core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "search_removal" TO core_ops, core_partner;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "search_version" TO core_ops, core_partner;
--> statement-breakpoint
GRANT SELECT ON "search_document", "search_document_source" TO core_app;
