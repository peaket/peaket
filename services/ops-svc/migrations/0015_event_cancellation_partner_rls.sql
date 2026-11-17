-- BAT-420 웨이브 끝 리뷰 S2(BUILD_ORDER GAT-110, docs/security/authz-matrix.md §5.3 'ops-svc 구현', docs/data.md event_cancellation_request, ASVS v5.0.0-8.4.1).
-- ops-svc의 테넌트 표 event_cancellation_request에 행 보안을 켠다(2차 방어. 1차는 앱의 core 판매 설정 promoterId 대조).
-- 그룹 역할 ops_partner(파트너 회차 취소 요청·상태 경로)·ops_app(관제 경로와 실행기, 전체를 보는 정책)을 만든다. 로그인할 수 있는 사용자는 비밀 관리가 만들어 이 역할에 넣는다.
-- 파트너 경로는 트랜잭션 첫 문장에서 set_config('app.tenant_id', 세션 테넌트, true)를 걸고, 값이 없거나 앞 트랜잭션이 남긴 빈 문자열이면 nullif로 NULL이라 0행이다.
-- 파트너 경로의 감사 체인 덧붙이기와 CS '판정 대기' 건 열기는 정의자 권한 함수 둘로만 한다(ops_partner는 audit_chain·cs_case를 직접 읽거나 쓰지 못한다).
-- commander 요청도 회차의 promoter_id를 적으므로 CHECK를 'PARTNER면 promoter_id가 있다'로 넓힌다. 기존 commander 행의 promoter_id는 채우지 않는다
-- (마이그레이션이 core-svc를 부를 수 없다. 파트너가 보지 못하는 옛 행으로 남는다).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    CREATE ROLE ops_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_partner') THEN
    CREATE ROLE ops_partner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  -- 역할이 이미 있어도(다른 환경에서 만든 값) 행 보안을 건너뛰는 속성이면 멈춘다
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ops_app', 'ops_partner') AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'ops_app·ops_partner 역할은 SUPERUSER·BYPASSRLS가 없어야 한다';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ops_app, ops_partner;

-- 관제 경로와 실행기: 모든 표를 읽고 쓴다(뒤에 생기는 표도 같다). 회차 취소 요청 표는 아래 정책이 전체를 준다
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ops_app;

-- 파트너 경로: 코드가 쓰는 만큼만이다. 회차 취소 요청은 읽기·넣기(고치기·지우기 없음), 멱등 기록 표(계정 범위, 테넌트 칸 없음)는 읽기·넣기
GRANT SELECT, INSERT ON event_cancellation_request TO ops_partner;
GRANT SELECT, INSERT ON idempotency_record TO ops_partner;

-- commander 요청도 회차의 promoter_id를 적는다(파트너 요청은 늘 있다)
ALTER TABLE event_cancellation_request DROP CONSTRAINT IF EXISTS event_cancellation_request_promoter_check;
ALTER TABLE event_cancellation_request ADD CONSTRAINT event_cancellation_request_promoter_check CHECK (requested_via <> 'PARTNER' OR promoter_id IS NOT NULL);

ALTER TABLE event_cancellation_request ENABLE ROW LEVEL SECURITY;
-- 값을 걸지 않으면 NULL, 앞 트랜잭션이 걸었던 연결이면 빈 문자열이라 nullif로 NULL로 바꾼다(둘 다 0건, authz-matrix §5.3)
DROP POLICY IF EXISTS event_cancellation_request_partner_read ON event_cancellation_request;
CREATE POLICY event_cancellation_request_partner_read ON event_cancellation_request FOR SELECT TO ops_partner
  USING (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS event_cancellation_request_partner_insert ON event_cancellation_request;
CREATE POLICY event_cancellation_request_partner_insert ON event_cancellation_request FOR INSERT TO ops_partner
  WITH CHECK (promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS event_cancellation_request_app_all ON event_cancellation_request;
CREATE POLICY event_cancellation_request_app_all ON event_cancellation_request FOR ALL TO ops_app USING (true) WITH CHECK (true);

-- 파트너 경로의 감사 체인 덧붙이기(정의자 권한). 그 테넌트가 이 트랜잭션에서 넣은 회차 취소 요청의 접수 기록(EVENT_CANCELLATION_REQUESTED)만 받는다.
-- 해시는 앱 appendAuditIn과 같다: record_sha256 = SHA-256(직전 해시 16진 글 || 정규화 기록 JSON 글). 정규화 JSON과 leaf_salt(32바이트)는 앱이 만들어 넘긴다
CREATE OR REPLACE FUNCTION ops_append_audit(p_record_type text, p_record_id uuid, p_record_json text, p_leaf_salt bytea, p_created_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_seq bigint;
  v_prev bytea;
  v_hash bytea;
BEGIN
  IF p_record_type <> 'EVENT_CANCELLATION_REQUESTED' THEN
    RAISE EXCEPTION 'ops_append_audit는 회차 취소 요청 접수 기록만 받는다' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.event_cancellation_request r
     WHERE r.request_id = p_record_id AND r.promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'ops_append_audit: 그 테넌트의 회차 취소 요청이 아니다' USING ERRCODE = '42501';
  END IF;
  IF p_leaf_salt IS NULL OR octet_length(p_leaf_salt) <> 32 THEN
    RAISE EXCEPTION 'ops_append_audit: leaf_salt는 32바이트다' USING ERRCODE = '22023';
  END IF;
  SELECT h.last_seq, h.last_hash INTO v_seq, v_prev FROM public.audit_chain_head h WHERE h.id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'audit_chain_head 행이 없다(마이그레이션 0000)';
  END IF;
  v_hash := sha256(convert_to(encode(v_prev, 'hex') || p_record_json, 'UTF8'));
  INSERT INTO public.audit_chain (seq, record_type, record_id, record_sha256, prev_hash, record_json, leaf_salt, created_at)
  VALUES (v_seq + 1, p_record_type, p_record_id, v_hash, v_prev, p_record_json::jsonb, p_leaf_salt, p_created_at);
  UPDATE public.audit_chain_head SET last_seq = v_seq + 1, last_hash = v_hash WHERE id = 1;
END
$$;
REVOKE ALL ON FUNCTION ops_append_audit(text, uuid, text, bytea, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_append_audit(text, uuid, text, bytea, timestamptz) TO ops_partner;

-- 파트너 경로의 CS 처리함 '판정 대기'(JUDGEMENT_PENDING) 건 열기(정의자 권한). 그 테넌트의 회차 취소 요청만 대상이고, 같은 대상의 열린 건은 하나다(cs_case_open_key)
CREATE OR REPLACE FUNCTION ops_open_cs_case(p_case_id uuid, p_request_id uuid, p_created_at timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.event_cancellation_request r
     WHERE r.request_id = p_request_id AND r.promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'ops_open_cs_case: 그 테넌트의 회차 취소 요청이 아니다' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.cs_case (id, kind, target_ref, status, created_at, updated_at)
  VALUES (p_case_id, 'JUDGEMENT_PENDING', p_request_id::text, 'OPEN', p_created_at, p_created_at)
  ON CONFLICT (kind, target_ref) WHERE status <> 'RESOLVED' DO NOTHING;
END
$$;
REVOKE ALL ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz) TO ops_partner;
