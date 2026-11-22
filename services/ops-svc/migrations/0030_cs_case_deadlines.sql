-- F-06-2 GAT-280(ADR-0364 결정 2~5): CS 처리함 건의 종류별 기한·배정·판·해결 메모·기한 경보 표시와 건 요청 기록(docs/data.md cs_case·cs_case_request).
-- 기한 값은 앱이 영업일 달력(공휴일 파일)으로 세어 넣는다(SQL에는 달력이 없다). next_due_at은 두 기한 중 이른 것이고, 둘 다 없으면 'infinity'라 목록 끝에 온다
-- (소유자 결정 2026-11-11, open-items 93번, data.md §5.1·§5.2 커서 정렬 칸 NOT NULL). 옛 행은 기한이 없어 'infinity'다.

ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS progress_due_at timestamptz;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS result_due_at timestamptz;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS next_due_at timestamptz NOT NULL
  GENERATED ALWAYS AS (coalesce(least(progress_due_at, result_due_at), 'infinity'::timestamptz)) STORED;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS assignee uuid;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS result_note text;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS due_soon_alerted_for timestamptz;
ALTER TABLE cs_case ADD COLUMN IF NOT EXISTS overdue_alerted_for timestamptz;

-- 해결 메모는 1~2,000자 평문이다(ADR-0364 결정 5). 감사 체인에는 본문을 남기지 않는다
ALTER TABLE cs_case DROP CONSTRAINT IF EXISTS cs_case_result_note_check;
ALTER TABLE cs_case ADD CONSTRAINT cs_case_result_note_check CHECK (result_note IS NULL OR char_length(result_note) BETWEEN 1 AND 2000);
ALTER TABLE cs_case DROP CONSTRAINT IF EXISTS cs_case_version_check;
ALTER TABLE cs_case ADD CONSTRAINT cs_case_version_check CHECK (version >= 1);

-- 처리함 목록: WHERE status <> 'RESOLVED' … ORDER BY next_due_at, id(data.md §5 'CS 처리함(ops)' 행)
CREATE INDEX IF NOT EXISTS cs_case_next_due_idx ON cs_case (next_due_at, id) WHERE status <> 'RESOLVED';

-- 받은 건 요청(support.cases-requested·내부 HTTP)의 eventKey를 한 번만 적는다. 해결된 건의 사건이 다시 와도 새 건을 열지 않는다(ADR-0364 결정 4)
CREATE TABLE IF NOT EXISTS cs_case_request (
  event_key text PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cs_case (id),
  kind text NOT NULL,
  received_at timestamptz NOT NULL,
  CONSTRAINT cs_case_request_event_key_check CHECK (char_length(event_key) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS cs_case_request_case_idx ON cs_case_request (case_id);
-- 관제 경로·실행기 역할(0015의 기본 권한이 새 표에도 주지만, 기본 권한을 만든 역할과 다를 수 있어 다시 적는다)
GRANT SELECT, INSERT, UPDATE, DELETE ON cs_case_request TO ops_app;

-- 파트너 경로의 '판정 대기' 건 열기(0015)에 판정 기한(요청 + 1영업일, 앱이 센 값)과 건 요청 기록을 더한다.
-- 넷째 인자는 기본값 NULL이라 세 인자 호출도 그대로 된다. 같은 이름의 함수가 하나만 남게 옛 서명을 지운다
DROP FUNCTION IF EXISTS ops_open_cs_case(uuid, uuid, timestamptz);
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
  ON CONFLICT (kind, target_ref) WHERE status <> 'RESOLVED' DO NOTHING;
  SELECT c.id INTO v_case_id FROM public.cs_case c
   WHERE c.kind = 'JUDGEMENT_PENDING' AND c.target_ref = p_request_id::text AND c.status <> 'RESOLVED'
   ORDER BY c.created_at LIMIT 1;
  IF v_case_id IS NOT NULL THEN
    -- 관제 경로(CsCaseEventCancellationCases)와 같은 eventKey다
    INSERT INTO public.cs_case_request (event_key, case_id, kind, received_at)
    VALUES ('judgement-pending:' || p_request_id::text, v_case_id, 'JUDGEMENT_PENDING', p_created_at)
    ON CONFLICT (event_key) DO NOTHING;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_open_cs_case(uuid, uuid, timestamptz, timestamptz) TO ops_partner;
