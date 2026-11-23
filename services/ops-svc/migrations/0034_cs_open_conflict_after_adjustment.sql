-- F-07-8 0033이 cs_case_open_key에 `kind <> 'SETTLEMENT_ADJUSTMENT_SUGGESTED'` 조건을 더한 뒤,
-- 0030의 ops_open_cs_case ON CONFLICT (kind, target_ref) WHERE status <> 'RESOLVED'가 그 부분 인덱스와 맞지 않아
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"으로 실패했다(CI 45259875444).
-- 함수의 충돌 조건을 0033의 인덱스 술어와 같게 다시 만든다.
CREATE OR REPLACE FUNCTION ops_open_cs_case(p_case_id uuid, p_request_id uuid, p_created_at timestamptz, p_result_due_at timestamptz DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_case_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.event_cancellation_request r
     WHERE r.request_id = p_request_id AND r.promoter_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'ops_open_cs_case: 그 테넌트의 회차 취소 요청이 아니다' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.cs_case (id, kind, target_ref, status, category, result_due_at, created_at, updated_at)
  VALUES (p_case_id, 'JUDGEMENT_PENDING', p_request_id::text, 'OPEN', 'EVENT_CANCELLATION', p_result_due_at, p_created_at, p_created_at)
  ON CONFLICT (kind, target_ref) WHERE status <> 'RESOLVED' AND kind <> 'SETTLEMENT_ADJUSTMENT_SUGGESTED' DO NOTHING;
  SELECT c.id INTO v_case_id FROM public.cs_case c
   WHERE c.kind = 'JUDGEMENT_PENDING' AND c.target_ref = p_request_id::text AND c.status <> 'RESOLVED'
   ORDER BY c.created_at LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    INSERT INTO public.cs_case_request (event_key, case_id, kind, received_at)
    VALUES ('judgement-pending:' || p_request_id::text, v_case_id, 'JUDGEMENT_PENDING', p_created_at)
    ON CONFLICT (event_key) DO NOTHING;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz, timestamptz) TO ops_partner;
