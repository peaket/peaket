-- 관제 판매 승인 경로의 DB 역할(core_ops, 판매 승인 LCH-080). 관제는 테넌트가 없어 모든 공연을 다루지만,
-- 팬 경로(core_app)와 파트너 경로(core_partner)의 권한을 넓히지 않는다(2차 방어, ADR-0241).
-- 이 역할은 판매 승인·반려가 쓰는 칸만 고치고, 승인 결과인 회차 판매 설정 사본(event_sale_config)을 쓴다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_ops') THEN
    CREATE ROLE core_ops NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_ops' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'core_ops 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO core_ops;
--> statement-breakpoint
-- 승인 트랜잭션이 읽는 공연·회차·배치본·가격 등급·판매 자격 명단이다(readState).
GRANT SELECT ON production, event, venue, price_tier, sale_eligibility_list TO core_ops;
--> statement-breakpoint
-- 승인은 공개본을 옮기는 칸만 고친다. 판매자·제목·장르·이미지 같은 다른 칸은 넓히지 않는다.
GRANT UPDATE (sale_review, sale_approved_at, sale_policy, sale_policy_version, pending_revision, place_id, requested_place, accessible_seating_check) ON production TO core_ops;
--> statement-breakpoint
-- 승인 뒤 더한 회차를 넣고, pending_revision의 회차 고침·규모를 공개본에 쓴다.
GRANT INSERT ON event TO core_ops;
--> statement-breakpoint
GRANT UPDATE (open_at, entry_opens_at, starts_at, ends_at, lobby_minutes, lobby_shuffle, open_batch, seat_assignment, per_person_limit, scale, version) ON event TO core_ops;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON event_sale_config TO core_ops;
--> statement-breakpoint
-- 행 보안: 관제는 모든 테넌트를 다루므로 조건 없이 연다. 팬 경로는 설정 사본을 읽기만 한다(BAT-051 읽기 계약).
CREATE POLICY production_ops ON production FOR ALL TO core_ops USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY event_ops ON event FOR ALL TO core_ops USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY venue_ops_read ON venue FOR SELECT TO core_ops USING (true);
--> statement-breakpoint
CREATE POLICY price_tier_ops_read ON price_tier FOR SELECT TO core_ops USING (true);
--> statement-breakpoint
CREATE POLICY sale_eligibility_list_ops_read ON sale_eligibility_list FOR SELECT TO core_ops USING (true);
--> statement-breakpoint
ALTER TABLE event_sale_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY event_sale_config_ops ON event_sale_config FOR ALL TO core_ops USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY event_sale_config_app_read ON event_sale_config FOR SELECT TO core_app USING (true);
