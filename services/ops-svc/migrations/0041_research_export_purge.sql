-- F-04-19 research_export_denial 90일 보존·전용 purge 역할(동결 로컬, LCH-330).
-- 소유자 결정(2026-11-27): research_export_denial은 90일 보존한다. ops_app에는 DELETE를 주지 않고,
-- 전용 ops_research_purger만 90일이 지난 행을 지우는 함수를 실행한다.
-- 감사 기록(audit_chain)·가명처리 기록(pseudonymization_log)·연구 내보내기(research_export)는 이 정리 대상이 아니다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_research_purger') THEN
    CREATE ROLE ops_research_purger NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_research_purger' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ops_research_purger 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
-- CronJob의 DSN은 이 로그인 역할로 접속해 ops_research_purger로 SET ROLE한다.
-- 로그인 역할 자체에는 표 권한을 주지 않는다(멤버십으로 함수 EXECUTE만 얻는다).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_research_purge_login') THEN
    CREATE ROLE ops_research_purge_login LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_research_purge_login' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ops_research_purge_login 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ops_research_purge_login;
--> statement-breakpoint
GRANT ops_research_purger TO ops_research_purge_login;
--> statement-breakpoint
REVOKE DELETE ON research_export_denial FROM ops_research_purge_login;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ops_research_purger;
--> statement-breakpoint
-- 0015의 기본 권한이 전체 표에 DELETE를 줄 수 있으므로, 거절 메타데이터는 앱 역할에서 명시적으로 거둔다.
REVOKE DELETE ON research_export_denial FROM ops_app;
--> statement-breakpoint
REVOKE DELETE ON research_export_denial FROM ops_research_purger;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_export_denial_at_idx ON research_export_denial (at);
--> statement-breakpoint
-- SECURITY DEFINER: purge 역할은 표 권한 없이 이 함수만 실행한다. 함수는 90일이 지난 행만 지운다.
CREATE OR REPLACE FUNCTION research_export_denial_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM research_export_denial
  WHERE at < now() - interval '90 days';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
-- SECURITY DEFINER 소유자가 research_export_denial DELETE를 갖는지 마이그레이션 때 한 번 확인한다.
-- 소유자가 DELETE를 잃었거나 바꿔야 하면 전용 owner 역할(예: ops_research_purge_owner)을 만들고
-- ALTER FUNCTION public.research_export_denial_purge() OWNER TO ops_research_purge_owner; 로 옮긴다(출시 전).
DO $$
DECLARE
  owner_name name;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO owner_name
  FROM pg_proc p
  WHERE p.oid = 'public.research_export_denial_purge()'::regprocedure;
  IF owner_name IS NULL THEN
    RAISE EXCEPTION 'research_export_denial_purge 함수를 찾지 못했다';
  END IF;
  IF NOT has_table_privilege(owner_name, 'public.research_export_denial', 'DELETE') THEN
    RAISE EXCEPTION 'research_export_denial_purge 소유자 %에게 research_export_denial DELETE가 없다', owner_name;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION research_export_denial_purge() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION research_export_denial_purge() FROM ops_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION research_export_denial_purge() TO ops_research_purger;
--> statement-breakpoint
COMMENT ON TABLE research_export_denial IS 'F-04-19 연구 내보내기 거절·경보 메타데이터. 90일 보존하며 ops_research_purger의 research_export_denial_purge()만 지운다.';
