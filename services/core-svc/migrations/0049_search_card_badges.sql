-- 찜 카드 배지(ProductionCard.badges, F-05-8 GAT-260 후속): 대표 회차의 정렬 방식·좌석 배정과 마지막 승인 판매 정책을
-- 검색 읽기 전용 연결(core_search)이 읽게 한다. core_search는 0023에서 search_* 표만 읽도록 허락받아
-- event·production 표를 직접 읽을 수 없다. 이 함수가 소유자 권한(SECURITY DEFINER)으로 그 칸만 돌려준다.
-- 표·칸은 바꾸지 않고 읽기만 더한다.
CREATE FUNCTION search_card_badges(p_event_ids uuid[])
RETURNS TABLE (
  event_id uuid,
  lobby_shuffle boolean,
  open_batch boolean,
  seat_assignment text,
  open_at timestamptz,
  starts_at timestamptz,
  per_person_limit integer,
  sale_policy jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT e."id", e."lobby_shuffle", e."open_batch", e."seat_assignment", e."open_at", e."starts_at", e."per_person_limit", p."sale_policy"
  FROM "event" e
  JOIN "production" p ON p."id" = e."production_id"
  WHERE e."id" = ANY (p_event_ids)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION search_card_badges(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION search_card_badges(uuid[]) TO core_app, core_ops, core_search;
