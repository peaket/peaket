-- 테넌트 표의 행 보안(2차 방어, docs/security/authz-matrix.md §5.3, ADR-0198 결정 8, ADR-0241, BUILD_ORDER HOT-172).
-- 역할은 로그인할 수 없는 묶음이다. 비밀번호가 있는 로그인 사용자는 비밀 관리가 만들어 이 역할에 넣는다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_app') THEN
    CREATE ROLE core_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'core_partner') THEN
    CREATE ROLE core_partner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- 역할이 이미 있어도(다른 환경에서 만든 값) 행 보안을 건너뛰는 속성이면 멈춘다
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('core_app', 'core_partner') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'core_app·core_partner 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO core_app, core_partner;
--> statement-breakpoint
-- 팬·관제 경로: 전체를 읽고 찜만 쓴다. 뒤에 쓰기가 생기면 그 표를 만드는 마이그레이션이 권한을 더한다
GRANT SELECT ON ALL TABLES IN SCHEMA public TO core_app;
--> statement-breakpoint
GRANT INSERT, DELETE ON wish TO core_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO core_app;
--> statement-breakpoint
-- 파트너 경로: 코드가 쓰는 만큼만이다. 공연은 칸까지 좁혀 판매 승인이나 판매자를 스스로 바꾸지 못한다
GRANT SELECT, INSERT ON production, event TO core_partner;
--> statement-breakpoint
GRANT UPDATE (sale_review, pending_revision) ON production TO core_partner;
--> statement-breakpoint
GRANT SELECT ON place, artist TO core_partner;
--> statement-breakpoint
GRANT INSERT ON production_artist, search_alias TO core_partner;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON idempotency_record TO core_partner;
--> statement-breakpoint
ALTER TABLE production ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 값을 걸지 않으면 NULL, 앞 트랜잭션이 걸었던 연결이면 빈 문자열이라 nullif로 NULL로 바꾼다(둘 다 0건, authz-matrix §5.3)
CREATE POLICY production_partner_tenant ON production FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY event_partner_tenant ON event FOR ALL TO core_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY production_app_read ON production FOR SELECT TO core_app USING (true);
--> statement-breakpoint
CREATE POLICY event_app_read ON event FOR SELECT TO core_app USING (true);
--> statement-breakpoint
-- 오픈 간격 판정(ADR-0198 결정 2): 공개 중인 다른 공연 회차의 오픈 시각만 준다. 소유자 권한으로 돌아 행 보안을 지나므로 칸을 늘리지 않는다
CREATE FUNCTION public_open_times(p_from timestamptz, p_to timestamptz, p_exclude uuid)
RETURNS TABLE (open_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT e.open_at
  FROM public.event e
  JOIN public.production p ON p.id = e.production_id
  WHERE e.production_id <> p_exclude
    AND e.status <> 'CANCELLED'
    AND e.open_at >= p_from
    AND e.open_at <= p_to
    AND p.sale_approved_at IS NOT NULL
    AND p.sale_review <> 'SUSPENDED'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public_open_times(timestamptz, timestamptz, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public_open_times(timestamptz, timestamptz, uuid) TO core_partner;
